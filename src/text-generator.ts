import TemplateInputModalUI from "./ui/template-input-modal";
import { App, Notice, Editor, EditorPosition, TFile } from "obsidian";
import { TextGeneratorSettings } from "./types";
import TextGeneratorPlugin from "./main";
import ReqFormatter from "./api-request-formatter";
import { SetPath } from "./ui/settings/components/set-path";
import ContextManager, { InputContext } from "./context-manager";
import { makeid, createFileWithInput, openFile } from "./utils";
import safeAwait from "safe-await";
import debug from "debug";
import RequestHandler from "./services/api-service";
const logger = debug("textgenerator:TextGenerator");
const heavyLogger = debug("textgenerator:TextGenerator:heavy");

import EmbeddingScope from "./scope/embeddings";
import { getHBValues } from "./utils/barhandles";

export default class TextGenerator extends RequestHandler {
  plugin: TextGeneratorPlugin;
  reqFormatter: ReqFormatter;
  contextManager: ContextManager;
  signal: AbortSignal;

  embeddingsScope: EmbeddingScope;

  constructor(app: App, plugin: TextGeneratorPlugin) {
    super(plugin);
    this.plugin = plugin;

    this.embeddingsScope = new EmbeddingScope();
    this.contextManager = new ContextManager(app, plugin);
    this.reqFormatter = new ReqFormatter(app, plugin, this.contextManager);
  }

  getCursor(editor: Editor, mode: "insert" | "replace" | string = "insert") {
    logger("getCursor");
    const cursor = editor.getCursor(mode == "replace" ? "from" : "to");

    // let selectedText = editor.getSelection();
    // if (selectedText.length === 0) {
    //   const lineNumber = editor.getCursor().line;
    //   selectedText = editor.getLine(lineNumber);
    //   if (selectedText.length !== 0) {
    //     // cursor.ch = selectedText.length;
    //     if (selectedText[selectedText.length - 1] === " ") {
    //       cursor.ch = selectedText.length - 1;
    //     }
    //   }
    // }
    logger("getCursor end");
    return cursor;
  }

  async generateFromTemplate(props: {
    params: Partial<TextGeneratorSettings>;
    templatePath: string;
    /** defaults to true */
    insertMetadata?: boolean;
    editor?: Editor;
    filePath?: string;
    /** defaults to true */
    activeFile?: boolean;
    additionalProps?: any;
    insertMode?: any;
  }) {
    const insertMetadata = props.insertMetadata ?? true;
    const activeFile = props.activeFile ?? true;

    const [errorContext, context] = await safeAwait(
      this.contextManager.getContext({
        filePath: props.filePath,
        editor: props.editor,
        insertMetadata,
        templatePath: props.templatePath,
        addtionalOpts: props.additionalProps,
      })
    );

    if (errorContext) {
      logger("tempalteToModal error", errorContext);
      return Promise.reject(errorContext);
    }

    switch (true) {
      case activeFile === false:
        await this.createToFile(
          props.params,
          props.templatePath,
          context,
          props.insertMode
        );
        break;

      default:
        if (!props.editor) throw new Error("TG: Editor was not selected");
        await this.generateInEditor({}, false, props.editor, context, {
          showSpinner: true,
          insertMode: props.insertMode,
        });
        break;
    }

    logger("generateFromTemplate end");
  }

  async generateBatchFromTemplate(
    files: TFile[],
    params: Partial<TextGeneratorSettings>,
    templatePath: string,
    insertMetadata = true,
    additionalProps: any = {},
    insertMode = false
  ) {
    // get files context
    const contexts = (await this.contextManager.getContextFromFiles(
      files,
      //   insertMetadata,
      templatePath,
      additionalProps
    )) as InputContext[];

    // make sure that failed context extractions are not included
    contexts.forEach((c, i) => {
      if (!c) {
        files.splice(i, 1);
        contexts.splice(i, 1);
      }
    });

    if (!files.length) throw new Error("You need to select files");

    // start generation
    await this.createToFiles(
      {
        ...params,
        ...contexts[0]?.options,
      },
      contexts,
      files,
      templatePath,
      insertMode
    );

    logger("generateFromTemplate end");
  }

  getMode(context: any) {
    return (
      context?.options?.frontmatter?.mode ||
      context?.options?.frontmatter?.config?.mode ||
      context?.options?.config?.mode ||
      "insert"
    );
  }

  async generateStreamInEditor(
    params: Partial<TextGeneratorSettings>,
    insertMetadata = false,
    editor: Editor,
    customContext?: InputContext
  ) {
    logger("generateStreamInEditor");

    const context =
      customContext ||
      (await this.contextManager.getContext({ editor, insertMetadata }));

    const mode = this.getMode(context);

    const startingCursor = this.getCursor(editor, mode);

    const cursor: typeof startingCursor = {
      ch: startingCursor.ch,
      line: startingCursor.line,
    };

    // --- show selected --
    const selectedRange = this.contextManager.getSelectionRange(editor);
    const currentSelections = editor.listSelections();
    editor.setSelections(
      currentSelections.length > 1
        ? currentSelections
        : [
            {
              anchor: selectedRange.from,
              head: selectedRange.to,
            },
          ]
    );
    // --

    try {
      const strm = await this.streamGenerate(
        context,
        insertMetadata,
        params,
        context.templatePath
      );

      // last letter before starting, (used to detirmin if we should add space at the begining)
      const txt = editor.getRange(
        {
          ch: startingCursor.ch - 1,
          line: startingCursor.line,
        },
        startingCursor
      );

      let postingContent = "";
      let stillPlaying = true;
      let firstTime = true;

      const writerTimer: any = setInterval(() => {
        if (!stillPlaying) return clearInterval(writerTimer);
        const posting = postingContent;
        if (!posting) return;

        if (firstTime) this.insertGeneratedText(posting, editor, cursor, mode);
        else this.insertGeneratedText(posting, editor, cursor, "stream");
        postingContent = postingContent.substring(posting.length);
        firstTime = false;

        cursor.ch += posting.length;

        if (!this.plugin.settings.freeCursorOnStreaming)
          editor.setCursor(cursor);

        this.plugin.updateSpinnerPos(cursor);
      }, 100);

      const allText =
        (await strm?.(
          async (cntnt, first) => {
            if (mode !== "insert") return;

            let content = cntnt;
            //   console.log({ content, first });

            if (first) {
              const alreadyDidnewLine = this.plugin.settings.prefix?.contains(`
			`);

              // here you can do some addition magic
              // check if its starting by space, and space doens't exist in note (used to detirmin if we should add space at the begining).
              if (txt.length && txt != " " && content != " ") {
                content = " " + content;
              }

              if (!alreadyDidnewLine && txt == ":" && cntnt != "\n") {
                content = "\n" + content;
              }

              // adding prefix here
              if (this.plugin.settings.prefix?.length) {
                content = this.plugin.settings.prefix + content;
              }

              postingContent = content;
            } else postingContent += content;
            logger("generateStreamInEditor message", { content });
            return content;
          },
          (err) => {
            this.endLoading(false);
            throw err;
          }
        )) || "";

      stillPlaying = false;

      editor.replaceRange(
        mode == "replace" ? allText : "",
        startingCursor,
        cursor
      );

      if (mode !== "replace")
        this.insertGeneratedText(allText, editor, startingCursor, mode);

      const nc = {
        ch: startingCursor.ch + allText.length,
        line: startingCursor.line,
      };

      editor.replaceRange("", startingCursor, nc);

      await new Promise((s) => setTimeout(s, 500));

      this.endLoading(true);

      this.insertGeneratedText(allText, editor, startingCursor, mode);

      // here we can do some selecting magic
      // editor.setSelection(startingCursor, cursor)

      editor.setCursor(nc);
    } catch (err: any) {
      this.plugin.handelError(err);
      // if catched error during or before streaming, it should return to its previews location
      editor.setCursor(cursor);
      this.endLoading(true);
      return Promise.reject(err);
    }
  }

  async generateInEditor(
    params: Partial<TextGeneratorSettings>,
    insertMetadata = false,
    editor: Editor,
    customContext?: InputContext,
    additionnalParams = {
      showSpinner: true,
      insertMode: false,
    }
  ) {
    const frontmatter = this.reqFormatter.getFrontmatter("", insertMetadata);
    console.log({ frontmatter });
    if (
      this.plugin.settings.stream &&
      this.plugin.textGenerator.LLMProvider?.streamable &&
      frontmatter.stream !== false
    ) {
      return this.generateStreamInEditor(
        params,
        insertMetadata,
        editor,
        customContext
      );
    }

    logger("generateInEditor");
    const cursor = this.getCursor(editor);

    const context =
      customContext ||
      (await this.contextManager.getContext({ editor, insertMetadata }));

    const [errorGeneration, text] = await safeAwait(
      this.generate(
        context,
        insertMetadata,
        params,
        context.templatePath,
        additionnalParams
      )
    );

    if (errorGeneration) {
      return Promise.reject(errorGeneration);
    }

    const mode = this.getMode(context);

    const prefix = this.plugin.settings.prefix;

    this.insertGeneratedText(
      prefix.length ? prefix + text : text,
      editor,
      cursor,
      mode
    );

    logger("generateInEditor end");
  }

  async generateToClipboard(
    params: Partial<TextGeneratorSettings>,
    templatePath: string,
    insertMetadata = false,
    editor: Editor
  ) {
    logger("generateToClipboard");
    const [errorContext, context] = await safeAwait(
      this.contextManager.getContext({ editor, insertMetadata, templatePath })
    );

    if (!context) {
      return Promise.reject("context doesn't exist");
    }

    const [errorGeneration, text] = await safeAwait(
      this.generate(context, insertMetadata, params, templatePath)
    );

    if (errorContext) {
      return Promise.reject(errorContext);
    }

    if (errorGeneration) {
      return Promise.reject(errorGeneration);
    }
    const data = new ClipboardItem({
      "text/plain": new Blob([text], {
        type: "text/plain",
      }),
    });
    await navigator.clipboard.write([data]);
    new Notice("Generated Text copied to clipboard");
    editor.setCursor(editor.getCursor());
    logger("generateToClipboard end");
  }

  async generatePrompt(
    promptText: string,
    insertMetadata = false,
    editor: Editor,
    outputTemplate: HandlebarsTemplateDelegate<any>
  ) {
    logger("generatePrompt");
    const cursor = this.getCursor(editor);

    let text = await this.generate({ context: promptText }, insertMetadata);

    if (outputTemplate) {
      text = outputTemplate({ output: text });
    }

    if (text) this.insertGeneratedText(text, editor, cursor);

    logger("generatePrompt end");
  }

  async createToFile(
    params: Partial<TextGeneratorSettings>,
    templatePath: string,
    context: InputContext,
    insertMode = false
  ) {
    logger("createToFile");
    const [errortext, text] = await safeAwait(
      this.generate(context, true, params, templatePath, {
        showSpinner: false,
        insertMode,
      })
    );

    if (errortext) {
      logger("tempalteToModal error", errortext);
      return Promise.reject(errortext);
    }

    const title = this.plugin.app.workspace.activeLeaf?.getDisplayText();
    const suggestedPath =
      "textgenerator/generations/" + title + "-" + makeid(3) + ".md";
    new SetPath(
      this.plugin.app,
      suggestedPath,
      async (path: string) => {
        const [errorFile, file] = await safeAwait(
          createFileWithInput(path, context.context + text, this.plugin.app)
        );
        if (errorFile) {
          logger("tempalteToModal error", errorFile);
          return Promise.reject(errorFile);
        }

        openFile(this.plugin.app, file);
      },
      {
        content: context.context + text,
        title,
      }
    ).open();
    logger("createToFile end");
  }

  async createToFiles(
    params: Partial<TextGeneratorSettings>,
    contexts: InputContext[],
    files: TFile[],
    templatePath: string,
    insertMode = false
  ) {
    logger("createToFile");

    const suggestedPath = `textgenerator/generations/${makeid(4)}`;

    new SetPath(
      this.plugin.app,
      suggestedPath,
      async (path: string) => {
        const [errortext, results] = await safeAwait(
          this.batchGenerate(
            contexts,
            true,
            params,
            templatePath,
            {
              showSpinner: false,
              insertMode,
            },
            async (text, i) => {
              const msg = text?.startsWith("FAILED:")
                ? `FAILED with File ${files[i]?.path}: ${text}`
                : `Finished file ${files[i]?.path}`;

              this.plugin.updateStatusBar(msg, true);

              const context = contexts[i];

              if (!context)
                return console.error("generation failed on", { i, text });

              const [errorFile, file] = await safeAwait(
                createFileWithInput(
                  path +
                    `/${text?.startsWith("FAILED:") ? "FAILED-" : ""}` +
                    files[i].path,
                  text,
                  this.plugin.app
                )
              );

              if (errorFile) {
                logger("tempalteToModal error", errorFile);
                return Promise.reject(errorFile);
              }
            }
          )
        );

        console.log({ results });
        const failed = results?.filter((r) => r?.startsWith("FAILED:"));

        if (failed?.length) {
          logger(`${failed.length} generations failed`, failed);
          console.warn(`${failed.length} generations failed`, failed);
          this.plugin.handelError(
            `${failed.length} generations failed, check console(CTRL+SHIFT+i) for more info`
          );
        }

        if (errortext || results == undefined) {
          logger("tempalteToModal error", errortext);
          return Promise.reject(errortext);
        }
      },
      {
        title: `${files.length} files`,
      }
    ).open();
    logger("createToFile end");
  }

  async createTemplateFromEditor(editor: Editor) {
    logger("createTemplateFromEditor");
    const title = this.plugin.app.workspace.activeLeaf?.getDisplayText();
    const content = editor.getValue();
    await this.createTemplate(content, title);
    logger("createTemplateFromEditor end");
  }

  async createTemplate(content: string, title = "") {
    logger("createTemplate");
    const promptInfo = `promptId: ${title}
name: 🗞️${title} 
description: ${title}
required_values: 
author: 
tags: 
version: 0.0.1`;

    let templateContent = content;
    const metadata = this.contextManager.getMetaData();
    // We have three cases: no Front-matter / Frontmatter without PromptInfo/ Frontmatter with PromptInfo
    if (!metadata?.hasOwnProperty("frontmatter")) {
      templateContent = `---\n${promptInfo}\n---\n${templateContent}`;
    } else if (!metadata["frontmatter"]?.hasOwnProperty("PromptInfo")) {
      if (templateContent.indexOf("---") !== -1) {
        templateContent = templateContent.replace("---", `---\n${promptInfo}`);
      } else {
        templateContent = `---\n${promptInfo}\n---\n${templateContent}`;
      }
    }
    const suggestedPath = `${this.plugin.settings.promptsPath}/local/${title}.md`;
    new SetPath(this.plugin.app, suggestedPath, async (path: string) => {
      const [errorFile, file] = await safeAwait(
        createFileWithInput(path, templateContent, this.plugin.app)
      );
      if (errorFile) {
        logger("createTemplate error", errorFile);
        return Promise.reject(errorFile);
      }
      openFile(this.plugin.app, file);
    }).open();
    logger("createTemplate end");
  }

  outputToBlockQuote(text: string) {
    let lines = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && line !== ">");
    lines = lines
      .map((line, index) => {
        if (line.includes("[!ai]+ AI")) {
          return ">";
        }

        return line.startsWith(">") ? line : "> " + line;
      })
      .filter((line) => line !== "");

    return "\n> [!ai]+ AI\n>\n" + lines.join("\n").trim() + "\n\n";
  }

  async insertGeneratedText(
    completion: string,
    editor: Editor,
    cur: EditorPosition | null = null,
    mode = "insert"
  ) {
    heavyLogger("insertGeneratedText");

    let text = completion;
    let cursor = cur || this.getCursor(editor);

    // if (mode !== "stream") {
    // 	 text = this.plugin.settings.prefix.replace(/\\n/g, "\n") + text;
    // }

    if (editor.listSelections().length > 0) {
      const anchor = editor.listSelections()[0].anchor;
      const head = editor.listSelections()[0].head;
      if (
        anchor.line > head.line ||
        (anchor.line === head.line && anchor.ch > head.ch)
      ) {
        cursor = editor.listSelections()[0].anchor;
      }
    }

    if (this.plugin.settings.outputToBlockQuote && mode !== "stream") {
      text = this.outputToBlockQuote(text);
    }

    if (mode === "insert" || mode === "stream") {
      editor.replaceRange(text, cursor);
    } else if (mode === "replace") {
      editor.replaceSelection(text);
    } else if (mode === "rename") {
      const sanitizedTitle = text
        .replace(/[*\\"/<>:|?\.]/g, "")
        .replace(/^\n*/g, "");
      const activeFile = this.plugin.app.workspace.getActiveFile();

      if (activeFile) {
        const renamedFilePath = activeFile.path.replace(
          activeFile.name,
          `${sanitizedTitle}.md`
        );
        await this.plugin.app.fileManager.renameFile(
          activeFile,
          renamedFilePath
        );
      } else {
        logger("Couldn't find active file");
      }
    }

    // editor.setCursor(editor.getCursor());

    heavyLogger("insertGeneratedText end");
  }

  async tempalteToModal(props: {
    params: Partial<TextGeneratorSettings>;
    /** Template path */
    templatePath?: string;
    /** Editor */
    editor: Editor;
    /** filePath */
    filePath?: string;
    /** defaults to true */
    activeFile?: boolean;
  }) {
    logger("tempalteToModal");
    const templateFile = this.plugin.app.vault.getAbstractFileByPath(
      props.templatePath || ""
    );

    const [errortemplateContent, templateContent] = await safeAwait(
      //@ts-ignore
      this.plugin.app.vault.adapter.read(templateFile?.path)
    );

    if (!templateContent) {
      return Promise.reject("templateContent is undefined");
    }

    if (errortemplateContent) {
      return Promise.reject(errortemplateContent);
    }

    const { inputContent, outputContent, preRunnerContent } =
      this.contextManager.splitTemplate(templateContent);

    // const variables = this.contextManager
    //   .extractVariablesFromTemplate(inputContent)
    //   .filter((variable) => !variable.includes("."));

    const variables = Array.from(
      new Set([
        ...(await getHBValues(inputContent)),
        ...(await getHBValues(outputContent)),
        ...(await getHBValues(preRunnerContent || "")),
      ]).values()
    );

    console.log(
      { variables },
      this.contextManager.extractVariablesFromTemplate(inputContent)
    );

    const metadata = this.getMetadata(props.templatePath || "");
    const tempateContext = await this.contextManager.getTemplateContext(props);

    new TemplateInputModalUI(
      this.plugin.app,
      this.plugin,
      variables,
      metadata,
      tempateContext,
      async (results: any) => {
        try {
          await this.generateFromTemplate({
            params: props.params,
            templatePath: props.templatePath || "",
            insertMetadata: true,
            filePath: props.filePath,
            editor: props.editor,
            activeFile: props.activeFile,
            additionalProps: results,
          });
        } catch (err: any) {
          this.plugin.handelError(err);
          this.endLoading(true);
        }
      }
    ).open();
    logger("tempalteToModal end");
  }

  getTemplates(
    _files?: TFile[] | undefined,
    promptsPath: string = this.plugin.settings.promptsPath
  ) {
    const files = _files || this.plugin.app.vault.getFiles();
    const paths: string[] = files
      .filter(
        (f) => f.path.includes(promptsPath) && !f.path.includes("/trash/")
      )
      .map((f) => f.path);
    return paths.map((s) => {
      return {
        title: s.substring(promptsPath.length + 1),
        path: s,
        ...this.getMetadata(s),
      };
    });
  }

  getMetadata(path: string) {
    logger("getMetadata");
    const metadata = this.getFrontmatter(path);

    const validedMetaData: Partial<{
      id: string;
      name: string;
      description: string;
      required_values: string[];
      author: string;
      tags: string[];
      version: string;
      commands: string[];
    }> = {};

    if (metadata?.PromptInfo?.promptId) {
      validedMetaData["id"] = metadata.PromptInfo.promptId;
    }

    if (metadata?.PromptInfo?.name) {
      validedMetaData["name"] = metadata.PromptInfo.name;
    }

    if (metadata?.PromptInfo?.description) {
      validedMetaData["description"] = metadata.PromptInfo.description;
    }

    if (metadata?.PromptInfo?.required_values) {
      validedMetaData["required_values"] =
        typeof metadata.PromptInfo.required_values == "string"
          ? metadata.PromptInfo.required_values.split(",")
          : metadata.PromptInfo.required_values;
    }

    if (metadata?.PromptInfo?.author) {
      validedMetaData["author"] = metadata.PromptInfo.author;
    }

    if (metadata?.PromptInfo?.tags) {
      validedMetaData["tags"] =
        typeof metadata.PromptInfo.tags == "string"
          ? metadata.PromptInfo.tags.split(",")
          : metadata.PromptInfo.tags;
    }

    if (metadata?.PromptInfo?.version) {
      validedMetaData["version"] = metadata.PromptInfo.version;
    }

    if (metadata?.PromptInfo?.commands) {
      validedMetaData["commands"] =
        typeof metadata.PromptInfo.commands == "string"
          ? metadata.PromptInfo.commands.split(",")
          : metadata.PromptInfo.commands;
    }

    logger("getMetadata end");
    return validedMetaData;
  }

  getFrontmatter(path = "") {
    logger("getFrontmatter");

    const frontMatter =
      this.contextManager.getFrontmatter(
        this.contextManager.getMetaData(path)
      ) || null;

    logger("getFrontmatter end", frontMatter);
    return frontMatter;
  }

  async templateGen(
    id: string,
    options: {
      editor?: Editor;
      filePath?: string;
      insertMetadata?: boolean;
      additionalProps?: any;
    }
  ): Promise<string> {
    this.plugin.endProcessing(true);

    const [errorContext, context] = await safeAwait(
      this.contextManager.getContext({
        editor: options.editor,
        filePath: options.filePath,
        insertMetadata: options.insertMetadata,
        templatePath: this.templatePaths[id],
        addtionalOpts: options.additionalProps,
      })
    );

    if (errorContext || !context) {
      throw errorContext;
    }

    console.log("going with context", { context });

    const [errorGeneration, text] = await safeAwait(
      this.generate(
        context,
        options.insertMetadata,
        options.additionalProps,
        this.templatePaths[id]
      )
    );

    if (errorGeneration) {
      throw errorGeneration;
    }

    return text || "";
  }

  /** record of template paths, from id */
  templatePaths: Record<string, string>;

  async getTemplate(id: string) {
    if (!this.plugin.textGenerator.templatePaths[id])
      throw new Error(`template with id:${id} wasn't found.`);

    const { context, inputTemplate, outputTemplate } =
      await this.contextManager.templateFromPath(
        this.plugin.textGenerator.templatePaths[id],
        {
          ...this.contextManager.getFrontmatter(
            this.contextManager.getMetaData(
              this.plugin.textGenerator.templatePaths[id]
            )
          ),
        }
      );

    return {
      context,
      inputTemplate,
      outputTemplate,
    };
  }
  async updateTemplatesCache() {
    const files = await this.plugin.getFilesOnLoad();
    const templates = this.plugin.textGenerator.getTemplates(
      // get files, it will be empty onLoad, that's why we are using this function
      files
    );

    this.templatePaths = {};
    templates.forEach((template) => {
      if (template.id) {
        const ss = template.path.split("/");
        this.templatePaths[ss[ss.length - 2] + "/" + template.id] =
          template.path;
      }
    });
    return templates;
  }
}
