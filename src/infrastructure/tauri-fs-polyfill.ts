/**
 * Tauri FileSystemDirectoryHandle polyfilled to work with FreeCut's
 * storage layer (fs-primitives.ts) inside the Tauri desktop app.
 *
 * Uses `any` types since the FSA API is complex and we only need
 * the subset that fs-primitives.ts actually calls.
 */

async function tauriInvoke(cmd: string, args: Record<string, unknown> = {}): Promise<any> {
  const { invoke } = await import('@tauri-apps/api/core')
  try {
    return await invoke(cmd, args)
  } catch (e) {
    console.error('[TauriFS] invoke ERROR:', cmd, e)
    throw e
  }
}

/**
 * Derive MIME type from a file name extension.
 * This is needed because the Tauri FS polyfill reads raw bytes and cannot
 * rely on browser MIME sniffing — the extension is the only available signal.
 * Falls back to 'application/octet-stream' for unknown extensions.
 */
const EXTENSION_MIME_MAP: Record<string, string> = {
  // Video
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  // Audio
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
  '.m4a': 'audio/x-m4a',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  // Image
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  // Lottie / JSON
  '.json': 'application/lottie+json',
  '.lottie': 'application/lottie+json',
}

function mimeFromFileName(name: string): string {
  const ext = name.toLowerCase().match(/\.[^.]+$/)?.[0]
  return (ext && EXTENSION_MIME_MAP[ext]) || 'application/octet-stream'
}

/**
 * A minimal Tauri-backed FileSystemDirectoryHandle.
 * Delegates to Rust filesystem commands via Tauri invoke.
 */
export class TauriDirectoryHandle {
  readonly kind = 'directory'
  readonly name: string
  readonly fullPath: string

  constructor(name: string, fullPath: string) {
    this.name = name
    this.fullPath = fullPath
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<any> {
    const childPath = `${this.fullPath}/${name}`
    try {
      const exists: boolean = await tauriInvoke('path_exists', { path: childPath })
      if (exists) return new TauriDirectoryHandle(name, childPath)
      if (options?.create) {
        await tauriInvoke('create_dir', { path: childPath })
        return new TauriDirectoryHandle(name, childPath)
      }
      throw new DOMException('Not found', 'NotFoundError')
    } catch (e: any) {
      if (options?.create && e?.name !== 'NotFoundError') {
        await tauriInvoke('create_dir', { path: childPath })
        return new TauriDirectoryHandle(name, childPath)
      }
      throw e
    }
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<any> {
    const childPath = `${this.fullPath}/${name}`
    try {
      const exists: boolean = await tauriInvoke('path_exists', { path: childPath })
      if (exists) return new TauriFileHandle(name, childPath)
      if (options?.create) {
        await tauriInvoke('write_file', { path: childPath, bytes: [] })
        return new TauriFileHandle(name, childPath)
      }
      throw new DOMException('Not found', 'NotFoundError')
    } catch (e: any) {
      if (options?.create && e?.name !== 'NotFoundError') {
        await tauriInvoke('write_file', { path: childPath, bytes: [] })
        return new TauriFileHandle(name, childPath)
      }
      throw e
    }
  }

  async removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
    const childPath = `${this.fullPath}/${name}`
    const isDirectory: boolean = await tauriInvoke('path_is_dir', { path: childPath })
    try {
      if (isDirectory) {
        await tauriInvoke('remove_dir', { path: childPath, recursive: options?.recursive ?? false })
      } else {
        await tauriInvoke('remove_file', { path: childPath })
      }
    } catch (error) {
      const exists: boolean = await tauriInvoke('path_exists', { path: childPath })
      if (!exists) {
        throw new DOMException(`Could not remove '${name}' — no such entry`, 'NotFoundError')
      }
      throw error
    }
  }

  values(): any {
    const self = this
    const entries: Array<{ name: string; is_dir: boolean }> = []
    let loaded = false
    let failed = false
    
    // Create an async iterable
    const iterable = {
      async *[Symbol.asyncIterator]() {
        if (!loaded && !failed) {
          try {
            const result: Array<{ name: string; is_dir: boolean }> =
              await tauriInvoke('list_dir', { path: self.fullPath })
            entries.push(...result)
          } catch (e) {
            failed = true
            throw e
          }
          loaded = true
        }
        for (const entry of entries) {
          const childPath = `${self.fullPath}/${entry.name}`
          if (entry.is_dir) {
            yield new TauriDirectoryHandle(entry.name, childPath)
          } else {
            yield new TauriFileHandle(entry.name, childPath)
          }
        }
      },
    }
    return iterable
  }

  async queryPermission(): Promise<'granted'> {
    return 'granted'
  }

  async requestPermission(): Promise<'granted'> {
    return 'granted'
  }

  isSameEntry(other: any): Promise<boolean> {
    return Promise.resolve(other instanceof TauriDirectoryHandle && other.fullPath === this.fullPath)
  }
}

/**
 * A minimal Tauri-backed FileSystemFileHandle.
 */
export class TauriFileHandle {
  readonly kind = 'file'
  readonly name: string
  readonly fullPath: string

  constructor(name: string, fullPath: string) {
    this.name = name
    this.fullPath = fullPath
  }

  async getFile(): Promise<File> {
    const bytes: number[] = await tauriInvoke('read_file_bytes', { path: this.fullPath })
    const uint8 = new Uint8Array(bytes)
    return new File([uint8], this.name, { type: mimeFromFileName(this.name) })
  }

  createWritable(): Promise<any> {
    return Promise.resolve(new TauriWritableStream(this.fullPath))
  }

  queryPermission(): Promise<'granted'> {
    return Promise.resolve('granted')
  }

  requestPermission(): Promise<'granted'> {
    return Promise.resolve('granted')
  }

  isSameEntry(other: any): Promise<boolean> {
    return Promise.resolve(other instanceof TauriFileHandle && other.fullPath === this.fullPath)
  }
}

/**
 * A writable stream that buffers writes and flushes to Tauri on close.
 */
class TauriWritableStream {
  private path: string
  private chunks: Uint8Array[] = []

  constructor(path: string) {
    this.path = path
  }

  async write(data: Blob | Uint8Array | string): Promise<void> {
    if (data instanceof Uint8Array) {
      this.chunks.push(data)
    } else if (data instanceof Blob) {
      const buf = await data.arrayBuffer()
      this.chunks.push(new Uint8Array(buf))
    } else {
      this.chunks.push(new TextEncoder().encode(data))
    }
  }

  async seek(_offset: number): Promise<void> {}

  async truncate(_size: number): Promise<void> {
    this.chunks = []
  }

  async close(): Promise<void> {
    const combined = concatenateUint8Arrays(this.chunks)
    const bytes = Array.from(combined)
    await tauriInvoke('write_file', { path: this.path, bytes })
    this.chunks = []
  }

  getWriter(): any {
    throw new Error('getWriter not implemented in Tauri polyfill')
  }

  abort(): Promise<void> {
    this.chunks = []
    return Promise.resolve()
  }
}

function concatenateUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}
