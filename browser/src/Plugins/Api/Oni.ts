import { EventEmitter } from "events"

import { IPluginChannel } from "./Channel"

import { Commands } from "./Commands"
import { Diagnostics } from "./Diagnostics"
import { Editor } from "./Editor"

import { DebouncedLanguageService } from "./DebouncedLanguageService"


// Language Client WIP
import * as os from "os"

import * as rpc from "vscode-jsonrpc"
import { exec, ChildProcess } from "child_process"

export interface LanguageClientInitializationParams {
    rootPath: string
}

export class LanguageClientLogger {
    public error(message: string): void {
        console.error(message)
    }

    public warn(message: string): void {
        console.warn(message)
    }

    public info(message: string): void {
        console.log(message)
    }

    public log(message: string): void {
        console.log(message)
    }
}

const wrapPathInFileUri = (path: string) => "file:///" + path
/**
 * Implementation of a client that talks to a server 
 * implement the Language Server Protocol
 */
export class LanguageClient {
    private _currentPromise: Promise<any>
    private _connection: rpc.MessageConnection
    private _process: ChildProcess
    private _currentOpenDocumentPath: string

    constructor(
        private _startCommand: string,
        private _initializationParams: LanguageClientInitializationParams,
        private _oni: Oni) {

        this._currentPromise = Promise.resolve(null)

        this._oni.on("buffer-update", (args: any) => {
            return this._enqueuePromise(() => this._onBufferUpdate(args))
        })

        const getQuickInfo = (textDocumentPosition: Oni.EventContext) => {
            return this._enqueuePromise(() => this._getQuickInfo(textDocumentPosition))
        }

        this._oni.registerLanguageService({
            getQuickInfo,
        })
    }

    public start(): Promise<any> {

        return <any>this._enqueuePromise(() => {
            // TODO: Pursue alternate connection mechanisms besides stdio - maybe Node IPC?
            this._process = exec(this._startCommand, { maxBuffer: 500 * 1024 * 1024 }, (err) => {
                if (err) {
                    console.error(err)
                    alert(err)
                }
            })

            this._connection = rpc.createMessageConnection(
                <any>(new rpc.StreamMessageReader(this._process.stdout)),
                <any>(new rpc.StreamMessageWriter(this._process.stdin)),
                new LanguageClientLogger())

            this._currentOpenDocumentPath = null

            this._connection.onNotification("window/logMessage", (args) => {
                console.log(JSON.stringify(args))
            })

            this._connection.onNotification("window/showMessage", (args) => {
                alert(args)
            })


            // Register additional notifications here
            this._connection.listen()

            return <any>this._connection.sendRequest("initialize", this._initializationParams)
        }, false)
    }

    private _enqueuePromise<T>(functionThatReturnsPromise: () => Promise<T>, requireConnection: boolean = true): Promise<T> {

        const promiseExecutor = () => {
            if (!this._connection && requireConnection) {
                return Promise.reject("No active language server connection")
            }

            return functionThatReturnsPromise()
        }

        return this._currentPromise
            .then(() => promiseExecutor(),
            (err) => {
                console.error(err)
                promiseExecutor()
            })
    }


    private _getQuickInfo(textDocumentPosition: Oni.EventContext): Promise<Oni.Plugin.QuickInfo> {
        return <any>this._connection.sendRequest("textDocument/hover", {
            textDocument: {
                uri: wrapPathInFileUri(textDocumentPosition.bufferFullPath)
            },
            position: {
                line: textDocumentPosition.line - 1,
                character: textDocumentPosition.column - 1
            }
        }).then((result: any) => {
            if (!result || !result.contents || result.contents.trim().length === 0) {
                throw "No quickinfo available"
            }

            return { title: result.contents.trim(), description: "" }
        })
    }

    // TODO: Type for this args
    private _onBufferUpdate(args: any): Promise<void> {
        const lines = args.bufferLines
        const { bufferFullPath, filetype, version } = args.eventContext
        const text = lines.join(os.EOL)

        if (this._currentOpenDocumentPath !== bufferFullPath) {
            this._currentOpenDocumentPath = bufferFullPath
            return <any>this._connection.sendNotification("textDocument/didOpen", {
                textDocument: {
                    uri: wrapPathInFileUri(bufferFullPath),
                    languageId: filetype,
                    version,
                    text,
                }
            })
        } else {
            return <any>this._connection.sendNotification("textDocument/didChange", {
                textDocument: {
                    uri: wrapPathInFileUri(bufferFullPath),
                    version,
                },
                contentChanges: [{
                    text
                }]
            })
        }
    }
}

/**
 * API instance for interacting with Oni (and vim)
 */
export class Oni extends EventEmitter implements Oni.Plugin.Api {

    private _editor: Oni.Editor
    private _commands: Commands
    private _languageService: Oni.Plugin.LanguageService
    private _diagnostics: Oni.Plugin.Diagnostics.Api

    public get diagnostics(): Oni.Plugin.Diagnostics.Api {
        return this._diagnostics
    }

    public get editor(): Oni.Editor {
        return this._editor
    }

    public get commands(): Oni.Commands {
        return this._commands
    }

    constructor(private _channel: IPluginChannel) {
        super()

        this._diagnostics = new Diagnostics(this._channel)
        this._editor = new Editor(this._channel)
        this._commands = new Commands()

        this._channel.onRequest((arg: any) => {
            this._handleNotification(arg)
        })
    }

    public createLanguageClient(initializationCommand: string, parameters: LanguageClientInitializationParams): LanguageClient {
        return new LanguageClient(initializationCommand, parameters, this)
    }

    public registerLanguageService(languageService: Oni.Plugin.LanguageService): void {
        this._languageService = new DebouncedLanguageService(languageService)
    }

    public setHighlights(file: string, key: string, highlights: Oni.Plugin.SyntaxHighlight[]) {
        this._channel.send("set-syntax-highlights", null, {
            file,
            key,
            highlights,
        })
    }

    public clearHighlights(file: string, key: string): void {
        this._channel.send("clear-syntax-highlights", null, {
            file,
            key,
        })
    }
    private _handleNotification(arg: any): void {
        if (arg.type === "buffer-update") {
            this.emit("buffer-update", arg.payload)
        } else if (arg.type === "buffer-update-incremental") {
            this.emit("buffer-update-incremental", arg.payload)
        } else if (arg.type === "event") {
            if (arg.payload.name === "CursorMoved") {
                this.emit("cursor-moved", arg.payload.context)
                this.emit("CursorMoved", arg.payload.context)
            } else if (arg.payload.name === "BufWritePost") {
                this.emit("buffer-saved", arg.payload.context)
                this.emit("BufWritePost", arg.payload.context)
            } else if (arg.payload.name === "BufEnter") {
                this.emit("buffer-enter", arg.payload.context)
                this.emit("BufEnter", arg.payload.context)
            }
        } else if (arg.type === "command") {
            this._commands.onCommand(arg.payload.command, arg.payload.args)
        } else if (arg.type === "request") {
            const requestType = arg.payload.name

            const originalContext = arg.payload.context

            const languageService = this._languageService || null
            if (!languageService) {
                return
            }

            switch (requestType) {
                case "quick-info":
                    this._languageService.getQuickInfo(arg.payload.context)
                        .then((quickInfo) => {
                            if (quickInfo && quickInfo.title) {
                                this._channel.send("show-quick-info", originalContext, {
                                    info: quickInfo.title,
                                    documentation: quickInfo.description,
                                })
                            }
                        }, (err) => {
                            this._channel.sendError("show-quick-info", originalContext, err)
                        })
                    break
                case "goto-definition":
                    languageService.getDefinition(arg.payload.context)
                        .then((definitionPosition) => {
                            this._channel.send("goto-definition", originalContext, {
                                filePath: definitionPosition.filePath,
                                line: definitionPosition.line,
                                column: definitionPosition.column,
                            })
                        })
                    break
                case "find-all-references":
                    languageService.findAllReferences(arg.payload.context)
                        .then((references) => {
                            this._channel.send("find-all-references", originalContext, {
                                references,
                            })
                        })
                    break
                case "completion-provider":
                    languageService.getCompletions(arg.payload.context)
                        .then((completions) => {
                            this._channel.send("completion-provider", originalContext, completions)
                        }, (err) => {
                            this._channel.sendError("completion-provider", originalContext, err)
                        })
                    break
                case "completion-provider-item-selected":
                    languageService.getCompletionDetails(arg.payload.context, arg.payload.item)
                        .then((details) => {
                            this._channel.send("completion-provider-item-selected", originalContext, {
                                details,
                            })
                        })
                    break
                case "format":
                    languageService.getFormattingEdits(arg.payload.context)
                        .then((formattingResponse) => {
                            this._channel.send("format", originalContext, formattingResponse)
                        })
                    break
                case "evaluate-block":
                    languageService.evaluateBlock(arg.payload.context, arg.payload.id, arg.payload.fileName, arg.payload.code)
                        .then((val) => {
                            this._channel.send("evaluate-block-result", originalContext, val)
                        })
                    break
                case "signature-help":
                    languageService.getSignatureHelp(arg.payload.context)
                        .then((val) => {
                            this._channel.send("signature-help-response", originalContext, val)
                        }, (err) => {
                            this._channel.sendError("signature-help-response", originalContext, err)
                        })
                    break
                default:
                    console.warn(`Unknown request type: ${requestType}`)

            }
        } else {
            console.warn("Unknown notification type")
        }
    }
}
