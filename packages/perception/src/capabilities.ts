import type { CapabilityMatrix } from './types.ts'

export interface CapabilityProbeOptions {
  hasWebGPU?: boolean
  hasNativeDecoder?: boolean
  hasWhisperLocal?: boolean
  hasLocalVisionWeights?: boolean
  hasLocalAudioModel?: boolean
  hasAuthoritativeRenderer?: boolean
}

/**
 * Transformers.js stores downloaded model assets in the browser Cache API.
 * Looking for the LFM model here is deliberately non-invasive: a capability
 * probe must never trigger a large model download merely to answer a status
 * question. The captioning provider performs that initialization only when a
 * user or agent actually requests visual understanding.
 */
export type CachedTransformerModelProbe = {
  model: string
  entryCount: number
  hasOnnxWeights: boolean
  hasTokenizerOrProcessor: boolean
  downloaded: boolean
}

async function probeCachedTransformerModel(model: string): Promise<CachedTransformerModelProbe> {
  const empty = { model, entryCount: 0, hasOnnxWeights: false, hasTokenizerOrProcessor: false, downloaded: false }
  if (typeof caches === 'undefined') return empty

  try {
    const urls: string[] = []
    for (const name of await caches.keys()) {
      const cache = await caches.open(name)
      const requests = await cache.keys()
      urls.push(...requests.map((request) => request.url).filter((url) => url.toLowerCase().includes(model.toLowerCase())))
    }
    const hasOnnxWeights = urls.some((url) => /(?:\.onnx|onnx\/)/i.test(url))
    const hasTokenizerOrProcessor = urls.some((url) => /(?:tokenizer|preprocessor|processor|config\.json)/i.test(url))
    return {
      model,
      entryCount: urls.length,
      hasOnnxWeights,
      hasTokenizerOrProcessor,
      downloaded: urls.length >= 4 && hasOnnxWeights && hasTokenizerOrProcessor,
    }
  } catch {
    // Cache inspection is an optional diagnostic; a restrictive browser
    // environment should report a degraded capability, not fail the editor.
  }
  return empty
}

export async function probeLocalVisualModelCaches() {
  const [lfm, clip] = await Promise.all([
    probeCachedTransformerModel('LiquidAI/LFM2.5-VL-450M-ONNX'),
    probeCachedTransformerModel('Xenova/clip-vit-base-patch32'),
  ])
  return { lfm, clip }
}

/**
 * Dynamically probe capability states at runtime instead of assuming static availability.
 */
export async function probeCapabilities(
  options: CapabilityProbeOptions = {},
): Promise<CapabilityMatrix> {
  const timestamp = new Date().toISOString()

  // 1. Detect WebGPU
  let webgpuAvailable = options.hasWebGPU ?? false
  if (options.hasWebGPU === undefined && typeof navigator !== 'undefined' && (navigator as any).gpu) {
    try {
      const adapter = await (navigator as any).gpu.requestAdapter()
      webgpuAvailable = !!adapter
    } catch {
      webgpuAvailable = false
    }
  }

  // 2. Native Decoder (Tauri backend or browser HTML5 video)
  const browserVideo = typeof document !== 'undefined' ? document.createElement('video') : null
  const browserDecoderAvailable = !!browserVideo && !!(
    browserVideo.canPlayType('video/mp4; codecs="avc1.42E01E"') ||
    browserVideo.canPlayType('video/quicktime') ||
    browserVideo.canPlayType('image/png')
  )
  const nativeDecoderAvailable = options.hasNativeDecoder ?? (
    typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window && browserDecoderAvailable
  )

  // 3. Vision model. In normal app use, report available only once the local
  // LFM assets have been cached and WebGPU is usable. A real inspection may
  // still initialize/download the model; this probe never blocks that path.
  const hasVisionWeights = options.hasLocalVisionWeights ?? (await probeLocalVisualModelCaches()).lfm.downloaded
  const visionAvailable = hasVisionWeights && webgpuAvailable

  // 4. Transcription (Whisper)
  // Without an already-loaded worker this is deliberately degraded: the
  // capability probe must not download or initialize a model merely to make a
  // dashboard look healthy.
  const transcriptionAvailable = options.hasWhisperLocal === true

  // 5. Audio Generation
  const audioGenAvailable = options.hasLocalAudioModel ?? false

  return {
    mediaDecode: {
      status: nativeDecoderAvailable ? 'available' : 'degraded',
      backend: nativeDecoderAvailable ? 'tauri_fs+html5_video' : 'webcodecs',
      reason: nativeDecoderAvailable ? undefined : 'MEDIA_DECODER_NOT_PROBED',
      lastProbe: timestamp,
    },
    sourceFrameExtraction: {
      status: nativeDecoderAvailable ? 'available' : 'degraded',
      backend: nativeDecoderAvailable ? 'native_canvas_pipeline' : 'html5_video_canvas',
      reason: nativeDecoderAvailable ? undefined : 'MEDIA_DECODER_NOT_PROBED',
      lastProbe: timestamp,
    },
    timelineFrameRendering: {
      status: options.hasAuthoritativeRenderer === true ? 'available' : 'degraded',
      backend: options.hasAuthoritativeRenderer === true ? 'sclip_authoritative_compositor' : 'not_observed',
      reason: options.hasAuthoritativeRenderer === true ? undefined : 'COMPOSITOR_CAPTURE_NOT_OBSERVED',
      lastProbe: timestamp,
    },
    visionUnderstanding: {
      status: visionAvailable ? 'available' : 'degraded',
      backend: visionAvailable ? 'local_lfm_worker' : 'structural_telemetry_fallback',
      reason: visionAvailable
        ? undefined
        : hasVisionWeights
          ? 'WEBGPU_BACKEND_UNAVAILABLE'
          : 'LOCAL_VISION_WEIGHTS_UNINITIALIZED',
      fallbackAvailable: true,
      fallback: 'composed_render_telemetry',
      lastProbe: timestamp,
    },
    sceneDetection: {
      status: 'available',
      backend: 'deterministic_histogram_detector',
      lastProbe: timestamp,
    },
    transcription: {
      status: transcriptionAvailable ? 'available' : 'degraded',
      backend: 'whisper_wasm_worker',
      reason: transcriptionAvailable ? undefined : 'TRANSCRIPTION_WORKER_NOT_PROBED',
      lastProbe: timestamp,
    },
    audioGeneration: {
      status: audioGenAvailable && webgpuAvailable ? 'available' : 'unavailable',
      backend: webgpuAvailable ? 'webgpu_musicgen_kokoro' : 'none',
      reason: webgpuAvailable ? undefined : 'WEBGPU_BACKEND_UNAVAILABLE',
      lastProbe: timestamp,
    },
    render: {
      status: options.hasAuthoritativeRenderer === true ? 'available' : 'degraded',
      backend: options.hasAuthoritativeRenderer === true ? 'sclip-render-queue' : 'not_observed',
      reason: options.hasAuthoritativeRenderer === true ? undefined : 'RENDER_BACKEND_NOT_PROBED',
      lastProbe: timestamp,
    },
  }
}
