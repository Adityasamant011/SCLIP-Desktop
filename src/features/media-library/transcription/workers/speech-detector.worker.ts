import { ALL_FORMATS, BlobSource, EncodedPacketSink, Input } from 'mediabunny'
import { downmixToMono, resampleTo16kHz } from '../lib/resampler'
import { buildSpeechDetection, type VadWindow } from '../speech-detection'

const SAMPLE_RATE = 16_000
const FRAME_SAMPLES = 512
const CONTEXT_SAMPLES = 64
const ORT_WASM_PATH = new URL('/wasm/', self.location.origin).href
const MODEL_URL = new URL('/models/silero-vad-v5.1.onnx', self.location.origin).href

type OrtModule = typeof import('onnxruntime-web')
type OrtSession = Awaited<ReturnType<OrtModule['InferenceSession']['create']>>
type OrtTensor = InstanceType<OrtModule['Tensor']>

let ortPromise: Promise<{ ort: OrtModule; ortImportMs: number }> | null = null
let sessionPromise: Promise<{
  session: OrtSession
  sessionInitMs: number
  modelLoadMs: number
  sessionCreateMs: number
}> | null = null

function getOrt(): Promise<{ ort: OrtModule; ortImportMs: number }> {
  if (!ortPromise) {
    const t0 = performance.now()
    ortPromise = import('onnxruntime-web').then((module) => {
      module.env.wasm.wasmPaths = ORT_WASM_PATH
      module.env.wasm.numThreads = 1
      const ortImportMs = performance.now() - t0
      return { ort: module, ortImportMs }
    })
  }
  return ortPromise
}

function getSession(): Promise<{
  session: OrtSession
  sessionInitMs: number
  modelLoadMs: number
  sessionCreateMs: number
}> {
  if (!sessionPromise) {
    const sessionStart = performance.now()
    sessionPromise = (async () => {
      const { ort } = await getOrt()
      const tModel0 = performance.now()
      const response = await fetch(MODEL_URL)
      if (!response.ok) throw new Error(`Could not load local Silero VAD (${response.status})`)
      const bytes = await response.arrayBuffer()
      const modelLoadMs = performance.now() - tModel0

      const tSess0 = performance.now()
      const session = await ort.InferenceSession.create(bytes, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      })
      const sessionCreateMs = performance.now() - tSess0
      const sessionInitMs = performance.now() - sessionStart

      return { session, sessionInitMs, modelLoadMs, sessionCreateMs }
    })()
  }
  return sessionPromise
}

self.onmessage = async (event: MessageEvent<{ type: 'analyze'; file: File }>) => {
  if (event.data.type !== 'analyze') return
  try {
    postMessage({ type: 'done', detection: await detect(event.data.file) })
  } catch (error) {
    postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
}

async function detect(file: File) {
  const detectStart = performance.now()
  if (typeof AudioDecoder === 'undefined') {
    throw new Error('WebCodecs AudioDecoder is not available for local speech detection')
  }
  const [{ ort, ortImportMs }, { session, sessionInitMs, modelLoadMs, sessionCreateMs }] =
    await Promise.all([getOrt(), getSession()])

  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) })
  let decodeMs = 0
  let resampleMs = 0
  let inferenceMs = 0

  try {
    const audioTrack = await input.getPrimaryAudioTrack()
    if (!audioTrack) throw new Error('No audio track found in file')
    const duration = await audioTrack.computeDuration()
    const decoderConfig = await audioTrack.getDecoderConfig()
    if (!decoderConfig) throw new Error('MediaBunny returned no decoder config for speech detection')
    const support = await AudioDecoder.isConfigSupported(decoderConfig)
    if (!support.supported) throw new Error(`Audio codec is not supported by this browser (${decoderConfig.codec})`)

    let pending = new Float32Array(0)
    let state: OrtTensor = new ort.Tensor('float32', new Float32Array(2 * 1 * 128), [2, 1, 128])
    let context = new Float32Array(CONTEXT_SAMPLES)
    let processedSamples = 0
    const windows: VadWindow[] = []

    const runAvailableFrames = async () => {
      while (pending.length >= FRAME_SAMPLES) {
        const frame = pending.slice(0, FRAME_SAMPLES)
        pending = pending.slice(FRAME_SAMPLES)
        const modelInput = new Float32Array(CONTEXT_SAMPLES + FRAME_SAMPLES)
        modelInput.set(context)
        modelInput.set(frame, CONTEXT_SAMPLES)
        const tInfer0 = performance.now()
        const output = await session.run({
          input: new ort.Tensor('float32', modelInput, [1, modelInput.length]),
          state,
          sr: new ort.Tensor('int64', BigInt64Array.of(BigInt(SAMPLE_RATE)), []),
        })
        inferenceMs += performance.now() - tInfer0
        state = output.stateN as OrtTensor
        context = modelInput.slice(-CONTEXT_SAMPLES)
        const start = processedSamples / SAMPLE_RATE
        processedSamples += FRAME_SAMPLES
        windows.push({ start, end: processedSamples / SAMPLE_RATE, probability: Number(output.output!.data[0] ?? 0) })
      }
    }

    let decodeError: Error | undefined
    const decoder = new AudioDecoder({
      output(audioData) {
        try {
          const channels: Float32Array[] = []
          for (let index = 0; index < audioData.numberOfChannels; index++) {
            const channel = new Float32Array(audioData.numberOfFrames)
            audioData.copyTo(channel, { format: 'f32-planar', planeIndex: index })
            channels.push(channel)
          }
          const tResample0 = performance.now()
          const resampled = resampleTo16kHz(downmixToMono(channels), audioTrack.sampleRate)
          resampleMs += performance.now() - tResample0
          const combined = new Float32Array(pending.length + resampled.length)
          combined.set(pending)
          combined.set(resampled, pending.length)
          pending = combined
          audioData.close()
        } catch (error) {
          decodeError = error instanceof Error ? error : new Error(String(error))
        }
      },
      error(error) { decodeError = new Error(`AudioDecoder error: ${error.message}`) },
    })
    decoder.configure(decoderConfig)
    const sink = new EncodedPacketSink(audioTrack)
    for await (const packet of sink.packets()) {
      if (decodeError) throw decodeError
      const tDecode0 = performance.now()
      decoder.decode(packet.toEncodedAudioChunk())
      if (decoder.decodeQueueSize > 8) await decoder.flush()
      decodeMs += performance.now() - tDecode0
      await runAvailableFrames()
    }
    const tFlush0 = performance.now()
    await decoder.flush()
    decodeMs += performance.now() - tFlush0
    if (decodeError) throw decodeError
    await runAvailableFrames()
    decoder.close()

    const totalDetectMs = performance.now() - detectStart
    const metrics = {
      ortImportMs: Number(ortImportMs.toFixed(1)),
      sessionInitMs: Number(sessionInitMs.toFixed(1)),
      modelLoadMs: Number(modelLoadMs.toFixed(1)),
      sessionCreateMs: Number(sessionCreateMs.toFixed(1)),
      decodeMs: Number(decodeMs.toFixed(1)),
      resampleMs: Number(resampleMs.toFixed(1)),
      inferenceMs: Number(inferenceMs.toFixed(1)),
      totalDetectMs: Number(totalDetectMs.toFixed(1)),
      processedSeconds: Number((processedSamples / SAMPLE_RATE).toFixed(3)),
      windowCount: windows.length,
    }

    return buildSpeechDetection(windows, duration, metrics)
  } finally {
    input.dispose()
  }
}
