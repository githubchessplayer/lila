package controllers

import strategygames.format.Forsyth.SituationPlus
import strategygames.format.{ FEN, Forsyth }
import strategygames.variant.Variant
import strategygames.{ Black, Color, GameLogic, Mode, Situation, White }
import play.api.libs.json.Json
import play.api.mvc._
import scala.concurrent.duration._
import views._

import lila.api.Context
import lila.app._
import lila.game.Pov
import lila.round.Forecast.{ forecastJsonWriter, forecastStepJsonFormat }
import lila.round.JsonView.WithFlags

final class UserAnalysis(
    env: Env,
    gameC: => Game
) extends LilaController(env)
    with TheftPrevention {

  def index = load("", Variant.libStandard(GameLogic.Chess()))

  def parseArg(arg: String) =
    arg.split("/", 2) match {
      case Array(key) => load("", Variant.orDefault(GameLogic.Chess(), key))
      case Array(key, fen) =>
        Variant.byKey(GameLogic.Chess()) get key match {
          case Some(variant)                              => load(fen, variant)
          case _ if FEN.clean(GameLogic.Chess(), fen) == Variant.libStandard(GameLogic.Chess()).initialFen => load(arg, Variant.libStandard(GameLogic.Chess()))
          case _                                          => load(arg, Variant.libFromPosition(GameLogic.Chess()))
        }
      case _ => load("", Variant.libStandard(GameLogic.Chess()))
    }

  def load(urlFen: String, variant: Variant) =
    Open { implicit ctx =>
      val decodedFen: Option[FEN] = lila.common.String
        .decodeUriPath(urlFen)
        .filter(_.trim.nonEmpty)
        .orElse(get("fen")) map(s => FEN.clean(variant.gameLogic, s))
      val pov         = makePov(decodedFen, variant)
      val orientation = get("color").flatMap(Color.fromName) | pov.color
      env.api.roundApi
        .userAnalysisJson(pov, ctx.pref, decodedFen, orientation, owner = false, me = ctx.me) map { data =>
        EnableSharedArrayBuffer(Ok(html.board.userAnalysis(data, pov)))
      }
    }

  private[controllers] def makePov(fen: Option[FEN], variant: Variant): Pov =
    makePov {
      fen.filter(_.value.nonEmpty).flatMap {
        Forsyth.<<<@(variant.gameLogic, variant, _)
      } | SituationPlus(Situation(variant.gameLogic, variant), 1)
    }

  private[controllers] def makePov(from: SituationPlus): Pov =
    Pov(
      lila.game.Game
        .make(
          chess = strategygames.Game(
            lib = from.situation.board.variant.gameLogic,
            situation = from.situation,
            turns = from.turns
          ),
          whitePlayer = lila.game.Player.make(White, none),
          blackPlayer = lila.game.Player.make(Black, none),
          mode = Mode.Casual,
          source = lila.game.Source.Api,
          pgnImport = None
        )
        .withId("synthetic"),
      from.situation.color
    )

  def game(id: String, color: String) =
    Open { implicit ctx =>
      OptionFuResult(env.game.gameRepo game id) { g =>
        env.round.proxyRepo upgradeIfPresent g flatMap { game =>
          val pov = Pov(game, Color.fromName(color) | White)
          negotiate(
            html =
              if (game.replayable) Redirect(routes.Round.watcher(game.id, color)).fuccess
              else {
                val owner = isMyPov(pov)
                for {
                  initialFen <- env.game.gameRepo initialFen game.id
                  data <-
                    env.api.roundApi
                      .userAnalysisJson(pov, ctx.pref, initialFen, pov.color, owner = owner, me = ctx.me)
                } yield NoCache(
                  Ok(
                    html.board
                      .userAnalysis(
                        data,
                        pov,
                        withForecast = owner && !pov.game.synthetic && pov.game.playable
                      )
                  )
                )
              },
            api = apiVersion => mobileAnalysis(pov, apiVersion)
          )
        }
      }
    }

  private def mobileAnalysis(pov: Pov, apiVersion: lila.common.ApiVersion)(implicit
      ctx: Context
  ): Fu[Result] =
    env.game.gameRepo initialFen pov.gameId flatMap { initialFen =>
      val owner = isMyPov(pov)
      gameC.preloadUsers(pov.game) zip
        (env.analyse.analyser get pov.game) zip
        env.game.crosstableApi(pov.game) flatMap { case ((_, analysis), crosstable) =>
          import lila.game.JsonView.crosstableWrites
          env.api.roundApi.review(
            pov,
            apiVersion,
            tv = none,
            analysis,
            initialFenO = initialFen.some,
            withFlags = WithFlags(division = true, opening = true, clocks = true, movetimes = true),
            owner = owner
          ) map { data =>
            Ok(data.add("crosstable", crosstable))
          }
        }
    }

  // XHR only
  def pgn =
    OpenBody { implicit ctx =>
      implicit val req = ctx.body
      env.importer.forms.importForm
        .bindFromRequest()
        .fold(
          jsonFormError,
          data =>
            env.importer.importer
              .inMemory(data)
              .fold(
                err => BadRequest(jsonError(err)).as(JSON).fuccess,
                { case (game, fen) =>
                  val pov = Pov(game, White)
                  env.api.roundApi.userAnalysisJson(
                    pov,
                    ctx.pref,
                    initialFen = fen,
                    pov.color,
                    owner = false,
                    me = ctx.me
                  ) map JsonOk
                }
              )
        )
    }

  def forecasts(fullId: String) =
    AuthBody(parse.json) { implicit ctx => _ =>
      import lila.round.Forecast
      OptionFuResult(env.round.proxyRepo pov fullId) { pov =>
        if (isTheft(pov)) fuccess(theftResponse)
        else
          ctx.body.body
            .validate[Forecast.Steps]
            .fold(
              err => BadRequest(err.toString).fuccess,
              forecasts =>
                env.round.forecastApi.save(pov, forecasts) >>
                  env.round.forecastApi.loadForDisplay(pov) map {
                    _.fold(JsonOk(Json.obj("none" -> true)))(JsonOk(_))
                  } recover { case Forecast.OutOfSync =>
                    JsonOk(Json.obj("reload" -> true))
                  }
            )
      }
    }

  def forecastsOnMyTurn(fullId: String, uci: String) =
    AuthBody(parse.json) { implicit ctx => _ =>
      import lila.round.Forecast
      OptionFuResult(env.round.proxyRepo pov fullId) { pov =>
        if (isTheft(pov)) fuccess(theftResponse)
        else
          ctx.body.body
            .validate[Forecast.Steps]
            .fold(
              err => BadRequest(err.toString).fuccess,
              forecasts => {
                val wait = 50 + (Forecast maxPlies forecasts min 10) * 50
                env.round.forecastApi.playAndSave(pov, uci, forecasts) >>
                  lila.common.Future.sleep(wait.millis) inject
                  Ok(Json.obj("reload" -> true))
              }
            )
      }
    }

  def help =
    Open { implicit ctx =>
      Ok(html.analyse.help(getBool("study"))).fuccess
    }
}
