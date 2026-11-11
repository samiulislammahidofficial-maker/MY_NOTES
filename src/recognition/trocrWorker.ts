import { env, pipeline } from '@huggingface/transformers';

// Default to local cached models unless deliberate download is requested
env.useBrowserCache = true;
env.allowLocalModels = false;

let recognizer: any = null;

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  try {
    if (msg.type === 'install') {
      env.allowRemoteModels = true;
      recognizer = await pipeline('image-to-text', 'Xenova/trocr-small-handwritten', {
        progress_callback: (p: any) => {
          self.postMessage({ type: 'progress', requestId: msg.requestId, progress: p });
        },
      });
      env.allowRemoteModels = false;
      self.postMessage({ type: 'installed', requestId: msg.requestId });
      return;
    }

    if (msg.type === 'recognize') {
      if (!recognizer) {
        env.allowRemoteModels = Boolean(msg.allowDownload);
        recognizer = await pipeline('image-to-text', 'Xenova/trocr-small-handwritten');
        env.allowRemoteModels = false;
      }
      const lines: string[] = [];
      for (const cropUrl of msg.crops as string[]) {
        const out = await recognizer(cropUrl, { max_new_tokens: 64 });
        const text = Array.isArray(out) ? out[0]?.generated_text ?? '' : out?.generated_text ?? '';
        lines.push(String(text).trim());
      }
      self.postMessage({ type: 'result', requestId: msg.requestId, text: lines.join('\n') });
    }
  } catch (err: unknown) {
    self.postMessage({
      type: 'error',
      requestId: msg.requestId,
      error: err instanceof Error ? err.message : 'Local TrOCR worker error',
    });
  }
};
