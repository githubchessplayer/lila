package lila.analyse

import strategygames.chess.format.pgn.{ Move, Pgn, Turn }
import strategygames.format.pgn.{ Glyphs, Tag }
import strategygames.opening.FullOpening
import strategygames.{ Color, Status }
import strategygames.variant.Variant

import lila.game.GameDrawOffers
import lila.game.Game

final class Annotator(netDomain: lila.common.config.NetDomain) {

  def apply(p: Pgn, game: Game, analysis: Option[Analysis]): Pgn =
    annotateStatus(game.winnerColor, game.status, game.variant) {
      annotateOpening(game.opening) {
        annotateTurns(
          annotateDrawOffers(p, game.drawOffers),
          analysis.??(_.advices)
        )
      }.copy(
        tags = p.tags + Tag(_.Annotator, netDomain)
      )
    }

  private def annotateStatus(winner: Option[Color], status: Status, variant: Variant)(p: Pgn) =
    lila.game.StatusText(status, winner, variant) match {
      case ""   => p
      case text => p.updateLastPly(_.copy(result = text.some))
    }

  private def annotateOpening(opening: Option[FullOpening.AtPly])(p: Pgn) =
    opening.fold(p) { o =>
      p.updatePly(o.ply, _.copy(opening = o.opening.toString().some))
    }

  private def annotateTurns(p: Pgn, advices: List[Advice]): Pgn =
    advices.foldLeft(p) { case (pgn, advice) =>
      pgn.updateTurn(
        advice.turn,
        turn =>
          turn.update(
            advice.color,
            move =>
              move.copy(
                glyphs = Glyphs.fromList(advice.judgment.glyph :: Nil),
                comments = advice.makeComment(withEval = true, withBestMove = true) :: move.comments,
                variations = makeVariation(turn, advice) :: Nil
              )
          )
      )
    }

  private def annotateDrawOffers(pgn: Pgn, drawOffers: GameDrawOffers): Pgn =
    if (drawOffers.isEmpty) pgn
    else
      drawOffers.normalizedPlies.foldLeft(pgn) { case (pgn, ply) =>
        pgn.updatePly(
          ply,
          move => {
            val color = !Color.fromPly(ply)
            move.copy(comments = s"$color offers draw" :: move.comments)
          }
        )
      }

  private def makeVariation(turn: Turn, advice: Advice): List[Turn] =
    Turn.fromMoves(
      advice.info.variation take 20 map { san =>
        Move(san)
      },
      turn plyOf advice.color
    )
}
