export type StsTurnModelAsset = { name: string; bytes: Uint8Array }
export const STS_STOP_CONFIDENCE = 0.95
export type StsTurnModelRequest =
  | { type: 'init'; assets: StsTurnModelAsset[] }
  | { type: 'predict'; text: string; output: string; audio?: Float32Array }

const intentRoot =
  'https://huggingface.co/onnx-community/minilm-student-L6_uniform_distilled-ONNX/resolve/6aa4deb590ea89b4b9ae217015042618defff20d'
const endpointRoot =
  'https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/f766f81d3cfdf7737ac64aad813d91bbfd56bf93'

export const STS_TURN_MODEL_FILES = [
  {
    name: 'intent-config.json',
    url: `${intentRoot}/config.json`,
    sizeBytes: 611,
    sha256: 'c9cbc8f2747dec1386148688081feb8d62b88aee6152072719afc37f0059933e'
  },
  {
    name: 'intent-tokenizer.json',
    url: `${intentRoot}/tokenizer.json`,
    sizeBytes: 2817083,
    sha256: 'c2aa01dfe25ff1b84ceb0324d0f2eb8f7f7c1b7ec663c7366423b8f48a2d47f2'
  },
  {
    name: 'intent-tokenizer_config.json',
    url: `${intentRoot}/tokenizer_config.json`,
    sizeBytes: 1456,
    sha256: '95fae7cd58b75438336d4091740680faffd6f7247229b2439eb811ff481a76c4'
  },
  {
    name: 'intent-model.onnx',
    url: `${intentRoot}/onnx/model_quantized.onnx`,
    sizeBytes: 25841969,
    sha256: '3735a768735eb87139c3f5e216f7aabc93b09c225871d2394bc54316b65c9b88'
  },
  {
    name: 'endpoint.onnx',
    url: `${endpointRoot}/smart-turn-v3.2-cpu.onnx`,
    sizeBytes: 8679182,
    sha256: '2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f'
  }
] as const

export type StsIntent = 'backchannel' | 'speech' | 'stop'
export type StsTurnPrediction = {
  intent: StsIntent
  confidence: number
  expectsAnswer: boolean
  complete: number
}
