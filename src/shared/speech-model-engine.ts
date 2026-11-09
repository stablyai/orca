export type SpeechEngine = 'sherpa' | 'transcribe-cpp'

/** GGUF models run on transcribe-cpp; everything else on sherpa-onnx. */
export function speechEngineForModelFiles(files: readonly string[]): SpeechEngine {
  return files.some((file) => file.endsWith('.gguf')) ? 'transcribe-cpp' : 'sherpa'
}
