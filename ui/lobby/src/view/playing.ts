import { h } from 'snabbdom';
import LobbyController from '../ctrl';
import { NowPlaying, Variant, VariantBoardSize } from '../interfaces';

function timer(pov: NowPlaying) {
  const date = Date.now() + pov.secondsLeft! * 1000;
  return h(
    'time.timeago',
    {
      hook: {
        insert(vnode) {
          (vnode.elm as HTMLElement).setAttribute('datetime', '' + date);
        },
      },
    },
    playstrategy.timeago(date)
  );
}

const boardSize = (boardSize?: VariantBoardSize) =>
  boardSize === undefined ? '' : `${boardSize.size[0]}x${boardSize.size[1]}`;

const boardClasses = (variant: Variant) =>
  `${variant.gameLib.name.toLowerCase()}${
    variant.gameLib.id === 1 && variant.boardSize !== undefined ? `.is${variant.boardSize.key}` : ''
  }`;

export default function (ctrl: LobbyController) {
  return h(
    'div.now-playing',
    ctrl.data.nowPlaying.map(pov =>
      h(
        'a.' + pov.variant.key,
        {
          key: `${pov.gameId}${pov.lastMove}`,
          attrs: { href: '/' + pov.fullId },
        },
        [
          h(`span.mini-board.cg-wrap.is2d.${boardClasses(pov.variant)}`, {
            attrs:
              pov.variant.gameLib.id === 1
                ? {
                    // Draughts
                    'data-state': `${pov.fen}|${boardSize(pov.variant.boardSize)}|${pov.color}|${pov.lastMove}`,
                  }
                : {
                    'data-state': `${pov.fen},${pov.color},${pov.lastMove}`,
                  },
            hook: {
              insert(vnode) {
                playstrategy.miniBoard.init(vnode.elm as HTMLElement);
              },
            },
          }),
          h('span.meta', [
            pov.opponent.ai ? ctrl.trans('aiNameLevelAiLevel', 'Stockfish', pov.opponent.ai) : pov.opponent.username,
            h(
              'span.indicator',
              pov.isMyTurn
                ? pov.secondsLeft && pov.hasMoved
                  ? timer(pov)
                  : [ctrl.trans.noarg('yourTurn')]
                : h('span', '\xa0')
            ), // &nbsp;
          ]),
        ]
      )
    )
  );
}
