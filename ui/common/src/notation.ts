import { NotationStyle } from 'chess';

interface ExtendedMoveInfo {
  san: string;
  uci: string;
  fen: string;
  prevFen?: string; //needed for shogi not xiangqi
}

interface ParsedMove {
  dest: string;
  orig: string;
}

type Board = { pieces: { [key: string]: string }; wMoved: boolean };

export function moveFromNotationStyle(notation: NotationStyle): (move: ExtendedMoveInfo, variant: Variant) => string {
  switch (notation) {
    case 'wxf':
      return xiangqiNotation;
    case 'usi':
      return shogiNotation;
    case 'san':
      return move => (move.san[0] === 'P' ? move.san.slice(1) : move.san);
    case 'uci':
      return move => move.uci;
  }
}

/*
 ** reads in a fen and outputs a map of board pieces - coordinates/keys are that of a shogi board [file+rank]
 */
export function readFen(fen: string, ranks: number, files: number) {
  const parts = fen.split(' '),
    board: Board = {
      pieces: {},
      wMoved: parts[1] === 'b',
    };

  parts[0]
    .split('[')[0]
    .split('/')
    .slice(0, ranks)
    .forEach((row, y) => {
      let x = files;
      let promoted = false;
      row.split('').forEach(v => {
        if (v == '~') return;
        const nb = parseInt(v, 10);
        if (nb) x -= nb;
        else if (v == '+') promoted = true;
        else {
          if (promoted) {
            board.pieces[`${x}${y + 1}`] = '+' + v;
          } else {
            board.pieces[`${x}${y + 1}`] = v;
          }
          x--;
          promoted = false;
        }
      });
    });

  return board;
}

export function parseUci(uci: string, files: number, ranks: number): ParsedMove {
  //account for ranks going up to 10, files are just a letter
  const p1 = uci[2] == '0' ? uci.slice(0, 3) : uci.slice(0, 2);
  const p2 = uci.slice(-1) == '0' ? uci.slice(-3) : uci.slice(-2);
  return {
    orig: parseUCISquareToUSI(p1, files, ranks)!,
    dest: parseUCISquareToUSI(p2, files, ranks)!,
  };
}

export function parseUCISquareToUSI(str: string, files: number, ranks: number): string | undefined {
  if (str.length > 3) return;
  const file = files - Math.abs(str.charCodeAt(0) - 'a'.charCodeAt(0));
  const rank = ranks + 1 - parseInt(str.slice(1));
  if (file < 1 || file > files || rank < 1 || rank > ranks) return;
  return file.toString() + rank.toString();
}

function shogiNotation(move: ExtendedMoveInfo, variant: Variant): string {
  const parsed = parseUci(move.uci, variant.boardSize.width, variant.boardSize.height),
    board = readFen(move.fen, variant.boardSize.height, variant.boardSize.width),
    prevBoard = readFen(move.prevFen!, variant.boardSize.height, variant.boardSize.width),
    dest = parsed.dest,
    connector = isCapture(prevBoard, board) ? 'x' : isDrop(prevBoard, board) ? '*' : '-',
    role = board.pieces[dest],
    piece = role[0] === '+' ? role[0] + role[1].toUpperCase() : role[0].toUpperCase(),
    origin = '',
    promotion = promotionSymbol(prevBoard, board, parsed);

  if (promotion == '+') return `${piece.slice(1)}${origin}${connector}${dest}${promotion}`;

  return `${piece}${origin}${connector}${dest}${promotion}`;
}

function isCapture(prevBoard: Board, board: Board): boolean {
  return Object.keys(prevBoard.pieces).length - Object.keys(board.pieces).length == 1;
}

function isDrop(prevBoard: Board, board: Board): boolean {
  return Object.keys(prevBoard.pieces).length - Object.keys(board.pieces).length == -1;
}

function promotionSymbol(prevBoard: Board, board: Board, parsed: ParsedMove): string {
  // '+' for promoted, '=' for chose not to promote, '' for normal move
  if (isDrop(prevBoard, board)) return '';

  const prevRole = prevBoard.pieces[parsed.orig];
  const currentRole = board.pieces[parsed.dest];

  if (prevRole !== currentRole) return '+';
  if (prevRole.includes('+')) return '';
  if (
    currentRole.toLowerCase() !== 'g' &&
    currentRole.toLowerCase() !== 'k' &&
    ((board.wMoved && ['1', '2', '3'].includes(parsed.dest.slice(1))) ||
      (!board.wMoved && ['7', '8', '9'].includes(parsed.dest.slice(1))))
  ) {
    return '=';
  } else {
    return '';
  }
}

function xiangqiNotation(move: ExtendedMoveInfo, variant: Variant): string {
  const parsed = parseUci(move.uci, variant.boardSize.width, variant.boardSize.height),
    board = readFen(move.fen, variant.boardSize.height, variant.boardSize.width),
    role = board.pieces[parsed.dest],
    piece = xiangqiRoleToPiece(role),
    //converting to xiangiq from shogi board notation -> ranks: black=1, white=10 ; rows: left-right white pov, 9-1 for white, 1-9 black
    prevFile = board.wMoved ? parseInt(parsed.orig[0]) : variant.boardSize.width + 1 - parseInt(parsed.orig[0]),
    prevRank = parseInt(parsed.orig.slice(1)),
    newFile = board.wMoved ? parseInt(parsed.dest[0]) : variant.boardSize.width + 1 - parseInt(parsed.dest[0]),
    newRank = parseInt(parsed.dest.slice(1)),
    isdiagonalMove = newRank !== prevRank && prevFile !== newFile,
    direction =
      newRank === prevRank
        ? '='
        : (board.wMoved && newRank < prevRank) || (!board.wMoved && newRank > prevRank)
        ? '+'
        : '-',
    movement = direction == '=' || isdiagonalMove ? newFile : Math.abs(newRank - prevRank);

  //Ammend notation due to multiple pawns in row, case 1: pair sideways, case 2: 3 or more up and down and sideways
  if (role === 'p' || role == 'P') {
    const pawnRole = board.wMoved ? 'P' : 'p';
    const addMovedPiece = prevFile !== newFile;
    const pawnRanks = numFriendlyPawnsInColumn(
      parsed.orig[0],
      board,
      variant.boardSize.height,
      pawnRole,
      addMovedPiece,
      prevRank,
      newRank
    );

    if (pawnRanks.length == 2) {
      const pawnOp =
        (pawnRanks.indexOf(prevRank) == 0 && board.wMoved) || (pawnRanks.indexOf(prevRank) == 1 && !board.wMoved)
          ? '+'
          : '-';
      return `${piece}${pawnOp}${direction}${movement}`;
    } else if (pawnRanks.length > 2) {
      const pawnNum = board.wMoved ? pawnRanks.indexOf(prevRank) + 1 : pawnRanks.length - pawnRanks.indexOf(prevRank);
      return `${pawnNum}${prevFile}${direction}${movement}`;
    } else {
      return `${piece}${prevFile}${direction}${movement}`;
    }
  } else {
    return `${piece}${prevFile}${direction}${movement}`;
  }
}

function xiangqiRoleToPiece(role: string) {
  switch (role) {
    case 'n':
    case 'N':
      return 'H';
    case 'b':
    case 'B':
      return 'E';
    default:
      return role.toUpperCase();
  }
}

function numFriendlyPawnsInColumn(
  origFile: string,
  board: Board,
  numRanks: number,
  role: string,
  addMovedPiece: boolean,
  origPieceRank: number,
  newPieceRank: number
): number[] {
  const pawnRanks: number[] = [];
  const ranks = [...Array(numRanks + 1).keys()].slice(1);
  ranks.forEach(r => {
    if (addMovedPiece && r === origPieceRank) pawnRanks.push(origPieceRank); // add the moved piece in this position to avoid sorting
    const piece = board.pieces[origFile + r.toString()];
    if (piece === role) {
      if (!addMovedPiece && r === newPieceRank) {
        pawnRanks.push(origPieceRank); // add moved pawn in original position in order to acquire its index from prev position
      } else {
        pawnRanks.push(r);
      }
    }
  });
  return pawnRanks;
}