'use strict'

import * as vscode from 'vscode'
import { LanguageClient } from 'vscode-languageclient'

/** All decorations that have been added so far */
let worksheetDecorationTypes: Map<vscode.TextDocument, vscode.TextEditorDecorationType[]> = new Map<vscode.TextDocument, vscode.TextEditorDecorationType[]>()

/** The number of blank lines that have been inserted to fit the output so far. */
let worksheetInsertedLines: Map<vscode.TextDocument, number> = new Map<vscode.TextDocument, number>()

/** The minimum margin to add so that the decoration is shown after all text. */
let worksheetMargin: Map<vscode.TextDocument, number> = new Map<vscode.TextDocument, number>()

/** Whether the given worksheet has finished evaluating. */
let worksheetFinished: Map<vscode.TextDocument, boolean> = new Map<vscode.TextDocument, boolean>()

/**
 * The command key for evaluating a worksheet. Exposed to users as
 * `Run worksheet`.
 */
export const worksheetEvaluateKey = "worksheet.evaluate"

/**
 * The command that is called to evaluate a worksheet after it has been evaluated.
 *
 * This is not exposed as a standalone callable command; but this command is triggered
 * when a worksheet is saved.
 */
export const worksheetEvaluateAfterSaveKey = "worksheet.evaluateAfterSave"

/** Is this document a worksheet? */
export function isWorksheet(document: vscode.TextDocument): boolean {
  return document.fileName.endsWith(".sc")
}

/**
 * This command is bound to `worksheetEvaluateAfterSaveKey`. This is implemented
 * as a command, because we want to display a progress bar that may stay for a while, and
 * VSCode will kill promises triggered by file save after some time.
 */
export function evaluateCommand() {
  const editor = vscode.window.activeTextEditor
  if (editor) {
    const document = editor.document
    if (isWorksheet(document)) {
      showWorksheetProgress(document)
    }
  }
}

/**
 * The VSCode command executed when the user select `Run worksheet`.
 *
 * We check whether the buffer is dirty, and if it is, we save it. Evaluation will then be
 * triggered by file save.
 * If the buffer is clean, we do the necessary preparation for worksheet (compute margin,
 * remove blank lines, etc.) and check if the buffer has been changed by that. If it is, we save
 * and the evaluation will be triggered by file save.
 * If the buffer is still clean, we send a `textDocument/didSave` notification to the language
 * server in order to start the execution of the worksheet.
 */
export function worksheetSave(client: LanguageClient) {
  const editor = vscode.window.activeTextEditor
  if (editor) {
    const document = editor.document
    if (isWorksheet(document)) {
      if (document.isDirty) document.save()
      else {
        _prepareWorksheet(document).then(_ => {
          if (document.isDirty) document.save()
          else {
            client.sendNotification("textDocument/didSave", {
              textDocument: { uri: document.uri.toString() }
            })
            showWorksheetProgress(document)
          }
        })
      }
    }
  }
}

/**
 * If the document that will be saved is a worksheet, resets the "worksheet state"
 * (margin and number of inserted lines), and removes redundant blank lines that
 * have been inserted by a previous evaluation.
 *
 * The file save operation is blocked until the worksheet is ready to be evaluated.
 *
 * @param event `TextDocumentWillSaveEvent`.
 */
export function prepareWorksheet(event: vscode.TextDocumentWillSaveEvent) {
  const document = event.document
  const setup = _prepareWorksheet(document)
  event.waitUntil(setup)
}

function _prepareWorksheet(document: vscode.TextDocument) {
  if (isWorksheet(document)) {
    return removeRedundantBlankLines(document)
      .then(_ => {
        removeDecorations(document)
        worksheetMargin.set(document, longestLine(document) + 5)
        worksheetInsertedLines.set(document, 0)
        worksheetFinished.set(document, false)
      })
  } else {
    return Promise.resolve()
  }
}

function showWorksheetProgress(document: vscode.TextDocument) {
  return vscode.window.withProgress({
    location: vscode.ProgressLocation.Window,
    title: "Evaluating worksheet"
  }, _ => {
    function isFinished() {
      return worksheetFinished.get(document) || false
    }
    return wait(isFinished, 500)
  })
}

/** Wait until `cond` evaluates to true; test every `delay` ms. */
function wait(cond: () => boolean, delayMs: number): Promise<boolean> {
  const isFinished = cond()
  if (isFinished) {
    return Promise.resolve(true)
  }
  else return new Promise(fn => setTimeout(fn, delayMs)).then(_ => wait(cond, delayMs))
}

/**
 * Handle the result of evaluating part of a worksheet.
 * This is called when we receive a `window/logMessage`.
 *
 * @param message The result of evaluating part of a worksheet.
 */
export function worksheetHandleMessage(message: string) {

  const editor = vscode.window.visibleTextEditors.find(e => {
    let uri = e.document.uri.toString()
    return uri == message.slice(0, uri.length)
  })

  if (editor) {
    let payload = message.slice(editor.document.uri.toString().length)
    if (payload == "FINISHED") {
      worksheetFinished.set(editor.document, true)
    } else {
      worksheetDisplayResult(payload, editor)
    }
  }
}

/**
 * Create a new `TextEditorDecorationType` showing `text`. The decoration
 * will appear `margin` characters after the end of the line.
 *
 * @param margin The margin in characters between the end of the line
 *               and the decoration.
 * @param text   The text of the decoration.
 * @return a new `TextEditorDecorationType`.
 */
function worksheetCreateDecoration(margin: number, text: string) {
  const decorationType =
    vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      after: {
        contentText: text,
        margin: `0px 0px 0px ${margin}ch`,
        fontStyle: "italic",
        color: "light gray",
      }
    })

  return decorationType
}

/**
 * Finds the length in characters of the longest line of `document`.
 *
 * @param document The document to inspect.
 * @return The length in characters of the longest line.
 */
function longestLine(document: vscode.TextDocument) {
  let maxLength = 0
  const lineCount = document.lineCount
  for (let i = 0; i < lineCount; ++i) {
    let length = document.lineAt(i).text.length
    maxLength = Math.max(maxLength, length)
  }

  return maxLength
}

/**
 * Remove all decorations added by worksheet evaluation.
 */
function removeDecorations(document: vscode.TextDocument) {
  const decorationTypes = worksheetDecorationTypes.get(document) || []
  decorationTypes.forEach(decoration =>
    decoration.dispose()
  )
}

/**
 * Remove the repeated blank lines in the source.
 *
 * Evaluating a worksheet can insert new lines in the worksheet so that the
 * output of a line fits below the line. Before evaluation, we remove blank
 * lines in the worksheet to keep its length under control. This could potentially
 * remove manually added blank lines.
 *
 * @param document The document where blank lines must be removed.
 * @return A `Thenable` removing the blank lines upon completion.
 */
function removeRedundantBlankLines(document: vscode.TextDocument) {

  const lineCount = document.lineCount
  let rangesToRemove: vscode.Range[] = []
  let rangeStart = 0
  let rangeEnd = 0
  let inRange = true

  function addRange() {
    inRange = false
    if (rangeStart < rangeEnd) {
      // Keep one line between separate chunks of code
      rangesToRemove.push(new vscode.Range(rangeStart, 0, rangeEnd - 1, 0))
    }
    return
  }

  for (let i = 0; i < lineCount; ++i) {
    const isEmpty = document.lineAt(i).isEmptyOrWhitespace
    if (inRange) {
      if (isEmpty) rangeEnd += 1
      else addRange()
    } else {
      if (isEmpty) {
        rangeStart = i
        rangeEnd = i + 1
        inRange = true
      }
    }
  }

  if (inRange) {
    rangeEnd = lineCount
    addRange()
  }

  return rangesToRemove.reverse().reduce((chain: Thenable<boolean>, range) => {
    return chain.then(_ => {
      const edit = new vscode.WorkspaceEdit()
      edit.delete(document.uri, range)
      return vscode.workspace.applyEdit(edit)
    })
  }, Promise.resolve(true))
}

/**
 * Parse and display the result of evaluating part of a worksheet.
 *
 * @see worksheetCreateDecoration
 *
 * @param message The message to parse.
 * @param ed      The editor where to display the result.
 * @return A `Thenable` that will insert necessary lines to fit the output
 *         and display the decorations upon completion.
 */
function worksheetDisplayResult(message: string, editor: vscode.TextEditor) {

  const colonIndex = message.indexOf(":")
  const lineNumber = parseInt(message.slice(0, colonIndex)) - 1 // lines are 0-indexed
  const evalResult = message.slice(colonIndex + 1)
  const resultLines = evalResult.trim().split(/\r\n|\r|\n/g)
  const margin = worksheetMargin.get(editor.document) || 0

  let insertedLines = worksheetInsertedLines.get(editor.document) || 0

  let decorationTypes = worksheetDecorationTypes.get(editor.document)
  if (!decorationTypes) {
    decorationTypes = []
    worksheetDecorationTypes.set(editor.document, decorationTypes)
  }

  // The line where the next decoration should be put.
  // It's the number of the line that produced the output, plus the number
  // of lines that we've inserted so far.
  let actualLine = lineNumber + insertedLines

  // If the output has more than one line, we need to insert blank lines
  // below the line that produced the output to fit the output.
  const addNewLinesEdit = new vscode.WorkspaceEdit()
  if (resultLines.length > 1) {
    const linesToInsert = resultLines.length - 1
    const editPos = new vscode.Position(actualLine + 1, 0) // add after the line
    addNewLinesEdit.insert(editor.document.uri, editPos, "\n".repeat(linesToInsert))
    insertedLines += linesToInsert
    worksheetInsertedLines.set(editor.document, insertedLines)
  }

  return vscode.workspace.applyEdit(addNewLinesEdit).then(_ => {
    for (let line of resultLines) {
      const decorationPosition = new vscode.Position(actualLine, 0)
      const decorationMargin = margin - editor.document.lineAt(actualLine).text.length
      const decorationType = worksheetCreateDecoration(decorationMargin, line)
      if (decorationTypes) decorationTypes.push(decorationType)

      const decoration = { range: new vscode.Range(decorationPosition, decorationPosition), hoverMessage: line }
      editor.setDecorations(decorationType, [decoration])
      actualLine += 1
    }
  })
}

