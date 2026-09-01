import { afterEach, describe, expect, it, vi } from 'vitest'

class FakeWorker {
  readonly posted: Array<Record<string, unknown>> = []
  terminated = false
  private readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>()

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  postMessage(message: Record<string, unknown>): void {
    this.posted.push(message)
    if (message.type === 'init') {
      queueMicrotask(() => this.emit({ type: 'ready' }))
    }
    if (message.type === 'describe') {
      queueMicrotask(() => this.emit({ type: 'caption', id: message.id, caption: 'A test frame' }))
    }
  }

  terminate(): void {
    this.terminated = true
  }

  private emit(data: Record<string, unknown>): void {
    for (const listener of this.listeners.get('message') ?? []) {
      listener({ data } as MessageEvent)
    }
  }
}

const createdWorkers: FakeWorker[] = []

vi.mock('../create-lfm-worker', () => ({
  createLfmSceneWorker: () => {
    const worker = new FakeWorker()
    createdWorkers.push(worker)
    return worker as unknown as Worker
  },
}))

afterEach(() => {
  createdWorkers.length = 0
  vi.resetModules()
})

describe('lfmCaptioningProvider', () => {
  it('keeps one initialized worker for successive image inspections', async () => {
    const { lfmCaptioningProvider } = await import('./lfm-captioning-provider')
    const frame = new Blob(['frame'], { type: 'image/jpeg' })

    await expect(lfmCaptioningProvider.captionImage(frame)).resolves.toMatchObject([
      { text: 'A test frame' },
    ])
    await expect(lfmCaptioningProvider.captionImage(frame)).resolves.toMatchObject([
      { text: 'A test frame' },
    ])

    expect(createdWorkers).toHaveLength(1)
    expect(createdWorkers[0]?.posted.filter((message) => message.type === 'init')).toHaveLength(1)
    expect(createdWorkers[0]?.posted.filter((message) => message.type === 'describe')).toHaveLength(2)
    expect(createdWorkers[0]?.terminated).toBe(false)
  })
})
