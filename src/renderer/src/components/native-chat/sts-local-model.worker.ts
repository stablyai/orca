import {
  AutoModel,
  AutoTokenizer,
  env,
  FeatureExtractionPipeline,
  WhisperFeatureExtractor
} from '@huggingface/transformers'
import * as ort from 'onnxruntime-web'
import wasmUrl from '../../../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm?url'
import wasmModuleUrl from '../../../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs?url'
import heads from '../../../../shared/sts-intent-weights.json'
import type {
  StsTurnModelAsset,
  StsTurnModelRequest,
  StsTurnPrediction
} from '../../../../shared/sts-turn-models'

let encoder: FeatureExtractionPipeline | undefined
let endpoint: ort.InferenceSession | undefined
const featureExtractor = new WhisperFeatureExtractor({
  feature_size: 80,
  sampling_rate: 16000,
  hop_length: 160,
  n_fft: 400,
  n_samples: 128000,
  nb_max_frames: 800
})

function classify(vector: ArrayLike<number>, head: { labels: string[]; weights: number[][] }) {
  const logits = head.weights.map((row) => {
    let sum = row.at(-1)
    if (sum === undefined || row.length !== vector.length + 1) {
      throw new Error('invalid_classifier_weights')
    }
    for (let i = 0; i < vector.length; i++) {
      sum += row[i] * vector[i]
    }
    return sum
  })
  const max = Math.max(...logits)
  const scores = logits.map((value) => Math.exp(value - max))
  const total = scores.reduce((a, b) => a + b, 0)
  const index = logits.indexOf(max)
  return { label: head.labels[index], confidence: scores[index] / total }
}

async function initialize(assets: StsTurnModelAsset[]) {
  const files = new Map(assets.map((file) => [file.name, file.bytes]))
  const names: Record<string, string> = {
    'config.json': 'intent-config.json',
    'tokenizer.json': 'intent-tokenizer.json',
    'tokenizer_config.json': 'intent-tokenizer_config.json',
    'onnx/model_quantized.onnx': 'intent-model.onnx'
  }
  env.allowRemoteModels = false
  env.allowLocalModels = true
  env.useBrowserCache = false
  env.useFSCache = false
  env.useCustomCache = true
  env.customCache = {
    match: async (request: string) => {
      const key = Object.keys(names).find((name) => request.endsWith(`/intent/${name}`))
      const bytes = key && files.get(names[key])
      return bytes ? new Response(new Uint8Array(bytes)) : undefined
    },
    put: async () => {}
  }
  ort.env.wasm.numThreads = 1
  ort.env.wasm.proxy = false
  ort.env.wasm.wasmPaths = { wasm: wasmUrl, mjs: wasmModuleUrl }
  if (env.backends.onnx.wasm) {
    env.backends.onnx.wasm.numThreads = 1
    env.backends.onnx.wasm.proxy = false
    env.backends.onnx.wasm.wasmPaths = { wasm: wasmUrl, mjs: wasmModuleUrl }
  }
  // Load the tokenizer first so all asset requests remain inside the verified local cache.
  const tokenizer = await AutoTokenizer.from_pretrained('intent', { local_files_only: true })
  const modelEncoder = await AutoModel.from_pretrained('intent', {
    dtype: 'q8',
    device: 'wasm',
    local_files_only: true
  })
  encoder = new FeatureExtractionPipeline({
    task: 'feature-extraction',
    tokenizer,
    model: modelEncoder
  })
  const model = files.get('endpoint.onnx')
  if (!model) {
    throw new Error('missing_endpoint_model')
  }
  endpoint = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] })
  await encoder('ready', { pooling: 'mean', normalize: true })
  files.clear()
}

async function predict(
  text: string,
  output: string,
  audio?: Float32Array
): Promise<StsTurnPrediction> {
  if (!encoder || !endpoint) {
    throw new Error('models_not_ready')
  }
  const embedded = await encoder(text.slice(-500), { pooling: 'mean', normalize: true })
  if (!(embedded.data instanceof Float32Array)) {
    throw new Error('invalid_embedding')
  }
  const intent = classify(embedded.data, heads.intent)
  let expectsAnswer = false
  if (output && intent.label === 'backchannel') {
    const context = await encoder(output.slice(-400), { pooling: 'mean', normalize: true })
    if (!(context.data instanceof Float32Array)) {
      throw new Error('invalid_context_embedding')
    }
    const prediction = classify(context.data, heads.context)
    expectsAnswer = prediction.label === 'question' && prediction.confidence >= 0.65
  }
  let complete = 0
  if (audio?.length) {
    const padded = new Float32Array(128000)
    const tail = audio.subarray(Math.max(0, audio.length - padded.length))
    padded.set(tail, padded.length - tail.length)
    let mean = 0
    for (const value of padded) {
      mean += value
    }
    mean /= padded.length
    let variance = 0
    for (const value of padded) {
      variance += (value - mean) ** 2
    }
    const deviation = Math.sqrt(variance / padded.length + 1e-7)
    for (let i = 0; i < padded.length; i++) {
      padded[i] = (padded[i] - mean) / deviation
    }
    const features = await featureExtractor(padded)
    if (!(features.input_features.data instanceof Float32Array)) {
      throw new Error('invalid_audio_features')
    }
    const tensor = new ort.Tensor('float32', features.input_features.data, [1, 80, 800])
    const result = await endpoint.run({ input_features: tensor })
    complete = Number(result[endpoint.outputNames[0]].data[0])
    for (const key of endpoint.outputNames) {
      result[key].dispose()
    }
    tensor.dispose()
  }
  if (intent.label !== 'backchannel' && intent.label !== 'speech' && intent.label !== 'stop') {
    throw new Error('invalid_model_label')
  }
  if (!Number.isFinite(complete)) {
    throw new Error('invalid_endpoint_prediction')
  }
  return { intent: intent.label, confidence: intent.confidence, expectsAnswer, complete }
}

let chain = Promise.resolve()
self.onmessage = (event: MessageEvent<StsTurnModelRequest & { id: number }>) => {
  const request = event.data
  chain = chain.then(async () => {
    try {
      if (request.type === 'init') {
        await initialize(request.assets)
        self.postMessage({ id: request.id, ready: true })
      } else {
        self.postMessage({
          id: request.id,
          result: await predict(request.text, request.output, request.audio)
        })
      }
    } catch {
      self.postMessage({ id: request.id, error: 'local_turn_model_failed' })
    }
  })
}
