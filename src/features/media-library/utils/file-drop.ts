import { getMediaType, getMimeType, validateMediaFileContent } from './validation'

export interface ExtractedMediaFileEntry {
  handle: FileSystemFileHandle
  file: File
  mediaType: 'video' | 'audio' | 'image' | 'lottie' | 'unknown'
}

export interface ExtractedMediaFileDropResult {
  supported: boolean
  entries: ExtractedMediaFileEntry[]
  errors: string[]
}

function supportsFileSystemDragDrop(dataTransfer: DataTransfer): boolean {
  const firstItem = dataTransfer.items[0]
  return !!firstItem && 'getAsFileSystemHandle' in firstItem
}

/**
 * File System Access handles are unavailable in WKWebView on some macOS
 * builds. Copy-mode imports only need getFile() plus permission methods, so a
 * dropped File can safely be adapted for that one import path. It is never
 * persisted as a linked source handle.
 */
function createEphemeralFileHandle(file: File): FileSystemFileHandle {
  return {
    kind: 'file',
    name: file.name,
    getFile: async () => file,
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    isSameEntry: async () => false,
  } as FileSystemFileHandle
}

export function formatMediaDropRejectionMessage(errors: string[]): string {
  const count = errors.length
  if (count === 0) return ''

  const examples = errors.slice(0, 3).join('; ')
  const overflow = count > 3 ? `; and ${count - 3} more` : ''
  const subject =
    count === 1 ? '1 dropped item was rejected' : `${count} dropped items were rejected`
  return `${subject}: ${examples}${overflow}.`
}

export async function extractValidMediaFileEntriesFromDataTransfer(
  dataTransfer: DataTransfer,
): Promise<ExtractedMediaFileDropResult> {
  if (!supportsFileSystemDragDrop(dataTransfer)) {
    const droppedFiles = Array.from(dataTransfer.files ?? [])
    if (droppedFiles.length === 0) {
      return {
        supported: false,
        entries: [],
        errors: [],
      }
    }

    const entries: ExtractedMediaFileEntry[] = []
    const errors: string[] = []
    for (const file of droppedFiles) {
      const validation = await validateMediaFileContent(file)
      if (!validation.valid) {
        errors.push(`${file.name}: ${validation.error}`)
        continue
      }
      entries.push({
        handle: createEphemeralFileHandle(file),
        file,
        mediaType: getMediaType(getMimeType(file)),
      })
    }
    return {
      supported: true,
      entries,
      errors,
    }
  }

  const items = Array.from(dataTransfer.items)
  const handlePromises: Promise<FileSystemHandle | null>[] = []
  for (const item of items) {
    if ('getAsFileSystemHandle' in item) {
      handlePromises.push(item.getAsFileSystemHandle())
    }
  }

  const rawHandles = await Promise.all(handlePromises)
  const entries: ExtractedMediaFileEntry[] = []
  const errors: string[] = []

  for (const handle of rawHandles) {
    if (!handle) {
      continue
    }

    if (handle.kind !== 'file') {
      const name = 'name' in handle ? handle.name : 'Dropped folder'
      errors.push(`${name}: folders are not supported yet. Drop media files directly.`)
      continue
    }

    const fileHandle = handle as FileSystemFileHandle
    try {
      const file = await fileHandle.getFile()
      const validation = await validateMediaFileContent(file)
      if (!validation.valid) {
        errors.push(`${file.name}: ${validation.error}`)
        continue
      }

      entries.push({
        handle: fileHandle,
        file,
        mediaType: getMediaType(getMimeType(file)),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to read file'
      errors.push(`Unknown file: ${message}`)
    }
  }

  return {
    supported: true,
    entries,
    errors,
  }
}
