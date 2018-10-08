package dotty.tools.dotc.transform

import dotty.tools.dotc.ast.Trees._
import dotty.tools.dotc.ast.tpd
import dotty.tools.dotc.core.Contexts._
import dotty.tools.dotc.core.Phases.Phase
import dotty.tools.dotc.core.Types.MethodicType
import dotty.tools.dotc.typer.{ConstFold, Inliner}


class InlineCalls extends MacroTransform { thisPhase =>
  import tpd._

  override def phaseName: String = InlineCalls.name

  override def run(implicit ctx: Context): Unit =
    if (!ctx.settings.YnoInline.value) super.run

  override def transformPhase(implicit ctx: Context): Phase = thisPhase.next

  protected def newTransformer(implicit ctx: Context): Transformer =
    new InlineCallsTransformer

  class InlineCallsTransformer extends Transformer {
    override def transform(tree: Tree)(implicit ctx: Context): Tree = tree match {
      case _: RefTree | _: GenericApply[_] if !tree.tpe.widenDealias.isInstanceOf[MethodicType] && Inliner.isInlineable(tree) && !ctx.reporter.hasErrors =>
        val tree2 = super.transform(tree) // transform arguments before inlining (inline arguments and constant fold arguments)
        transform(Inliner.inlineCall(tree2, tree.tpe.widen))
      case _: MemberDef =>
        val newTree = super.transform(tree)
        newTree.symbol.defTree = newTree // update tree set in PostTyper or set for inlined members
        newTree
      case _ =>
        ConstFold(super.transform(tree))
    }
  }

}

object InlineCalls {
  final val name = "inlineCalls"
}
