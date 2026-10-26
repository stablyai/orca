import { resampleToRate } from '../../../../shared/audio-resample'
import type {
  StsTurnModelAsset,
  StsTurnModelRequest,
  StsTurnPrediction
} from '../../../../shared/sts-turn-models'

type Reply = { id: number; ready?: boolean; result?: StsTurnPrediction; error?: string }

export class StsLocalModelClient {
  private worker: Worker | undefined
  private nextId = 0
  private closed = false
  private audio = new Float32Array(128000)
  private audioLength = 0
  private pending = new Map<
    number,
    {
      resolve: (reply: Reply) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()

  async start(load: () => Promise<StsTurnModelAsset[]>): Promise<void> {
    const assets = await load()
    if (this.closed) {
      throw new Error('turn_model_closed')
    }
    this.worker = new Worker(new URL('./sts-local-model.worker.ts', import.meta.url), {
      type: 'module'
    })
    this.worker.onmessage = (event: MessageEvent<Reply>) => {
      const request = this.pending.get(event.data.id)
      if (!request) {
        return
      }
      this.pending.delete(event.data.id)
      clearTimeout(request.timer)
      if (event.data.error) {
        request.reject(new Error('local_turn_model_failed'))
      } else {
        request.resolve(event.data)
      }
    }
    this.worker.onerror = () => this.close()
    await this.request({ type: 'init', assets }, 60_000)
  }

  feed(samples: Float32Array, rate: number): void {
    if (
      this.closed ||
      !Number.isFinite(rate) ||
      rate < 8000 ||
      rate > 192000 ||
      samples.length > rate * 2
    ) {
      return
    }
    const input = resampleToRate(samples, rate, 16000)
    const tail = input.subarray(Math.max(0, input.length - this.audio.length))
    const kept = Math.min(this.audioLength, this.audio.length - tail.length)
    this.audio.copyWithin(0, this.audioLength - kept, this.audioLength)
    for (let i = 0; i < tail.length; i++) {
      this.audio[kept + i] = Number.isFinite(tail[i]) ? tail[i] : 0
    }
    this.audioLength = kept + tail.length
  }

  async predict(text: string, output: string, final: boolean): Promise<StsTurnPrediction> {
    const reply = await this.request(
      {
        type: 'predict',
        text,
        output,
        audio: final ? this.audio.slice(0, this.audioLength) : undefined
      },
      5000
    )
    if (!reply.result) {
      throw new Error('missing_turn_prediction')
    }
    return reply.result
  }

  resetAudio(): void {
    this.audio.fill(0)
    this.audioLength = 0
  }

  private request(message: StsTurnModelRequest, timeout: number): Promise<Reply> {
    if (this.closed || !this.worker || this.pending.size >= 4) {
      return Promise.reject(new Error('turn_model_unavailable'))
    }
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('turn_model_timeout'))
        this.close()
      }, timeout)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.worker?.postMessage({ ...message, id })
      } catch {
        this.close()
      }
    })
  }

  close(): void {
    this.closed = true
    this.worker?.terminate()
    this.worker = undefined
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error('turn_model_closed'))
    }
    this.pending.clear()
    this.resetAudio()
  }
}
