import { App, TAbstractFile } from "obsidian";
import { Extractor } from "./content-extractor";
import TextGeneratorPlugin from "src/main";
import debug from "debug";

const logger = debug("textgenerator:Extractor:AudioExtractor");

import { WhisperProviderName } from "../ui/settings/sections/otherProviders/whisper";
export default class AudioExtractor extends Extractor {
  constructor(app: App, plugin: TextGeneratorPlugin) {
    super(app, plugin);
  }

  async convert(docPath: string) {
    logger("convert", { docPath });

    const xt = docPath.split(".");
    const extension = xt[xt.length - 1];

    const audioBuffer = await this.app.vault.adapter.readBinary(docPath);
    const fileSizeInMB = audioBuffer.byteLength / (1024 * 1024);

    if (fileSizeInMB > 24) {
      this.plugin.handelError(new Error("File size exceeds the 24 MB limit."));
      return "";
    }

    const transcript = await this.generateTranscript(audioBuffer, extension);
    logger("convert end", { transcript });
    return transcript;
  }

  async extract(filePath: string) {
    const supportedAudioExtensions = [
      "mp3",
      "mp4",
      "mpeg",
      "mpga",
      "m4a",
      "wav",
      "webm",
    ];
    const embeds = this.app.metadataCache
      .getCache(filePath)
      ?.embeds?.filter((embed) =>
        supportedAudioExtensions.some((ext) => embed.link.endsWith(`.${ext}`))
      );
    if (!embeds) {
      return [];
    }
    return embeds
      .map(
        (embed) =>
          this.app.metadataCache.getFirstLinkpathDest(embed.link, filePath)
            ?.path
      )
      .filter(Boolean) as string[];
  }

  async generateTranscript(audioBuffer: ArrayBuffer, filetype: string) {
    try {
      const endpoint = new URL(
        this.plugin.settings.LLMProviderOptions[WhisperProviderName]?.basePath
          ?.length
          ? this.plugin.settings.LLMProviderOptions[WhisperProviderName]
              ?.basePath
          : this.plugin.settings.endpoint ||
            this.plugin.defaultSettings.endpoint
      );

      if (
        endpoint.host.contains("openai") &&
        this.plugin.settings.api_key.length < 1
      )
        throw new Error("OpenAI API Key is not provided.");

      const formData = this.createFormData(audioBuffer, filetype);
      this.plugin.startProcessing(false);

      // TODO: this needs to be supported in the llm provider, or searches for llm with openai key
      // if not, then show error message
      const response = await fetch(
        new URL(`${endpoint.pathname}/audio/transcriptions`, endpoint).href,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.plugin.settings.api_key}`,
          },
          body: formData,
        }
      );

      const jsonResponse = await response.json();

      if ("text" in jsonResponse) return jsonResponse.text;
      else
        this.plugin.handelError(
          new Error("Error. " + JSON.stringify(jsonResponse))
        );
    } catch (err: any) {
      this.plugin.handelError(err);
    } finally {
      this.plugin.endProcessing(false);
    }
  }

  createFormData(audioBuffer: BlobPart, filetype: string) {
    const formData = new FormData();
    const blob = new Blob([audioBuffer], { type: `audio/${filetype}` });
    formData.append("file", blob, `audio.${filetype}`);
    formData.append("model", "whisper-1");

    return formData;
  }
}
