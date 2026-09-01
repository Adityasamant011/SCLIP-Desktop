export const MEDIA_FILE_PICKER_TYPES = [
  {
    description: 'Media files',
    accept: {
      'video/*': ['.mp4', '.webm', '.mov', '.avi', '.mkv'],
      'audio/*': ['.mp3', '.wav', '.ogg', '.m4a', '.aac'],
      'image/*': ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'],
      'application/lottie+json': ['.json', '.lottie'],
    },
  },
] satisfies FilePickerAcceptType[]

const FORMAT_LABEL_OVERRIDES: Record<string, string> = {
  webm: 'WebM',
  webp: 'WebP',
}

export function getSupportedMediaFormatLabels(): string[] {
  const extensions = Object.values(MEDIA_FILE_PICKER_TYPES[0]?.accept ?? {}).flat()
  return extensions.map((extension) => {
    const normalized = extension.replace(/^\./, '')
    return FORMAT_LABEL_OVERRIDES[normalized] ?? normalized.toUpperCase()
  })
}

export function hasMediaFilePickerSupport(): boolean {
  return isTauriDesktop() || (typeof window !== 'undefined' && 'showOpenFilePicker' in window)
}

export async function showMediaFilePicker(options?: {
  multiple?: boolean
}): Promise<FileSystemFileHandle[]> {
  if (isTauriDesktop()) {
    return showWebKitFilePicker(options)
  }

  return window.showOpenFilePicker({
    multiple: options?.multiple ?? true,
    types: MEDIA_FILE_PICKER_TYPES,
  })
}

/**
 * WKWebView supports a regular file input reliably, while the Tauri dialog
 * plugin can hang this application's native media picker callback. The
 * returned files are copied into the project just like any other import.
 */
function showWebKitFilePicker(options?: { multiple?: boolean }): Promise<FileSystemFileHandle[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = options?.multiple ?? true
    input.accept = Object.values(MEDIA_FILE_PICKER_TYPES[0]?.accept ?? {}).flat().join(',')
    input.style.display = 'none'

    const cleanup = () => input.remove()
    input.addEventListener(
      'change',
      () => {
        const handles = Array.from(input.files ?? []).map(
          (file) => new BrowserFileHandle(file) as unknown as FileSystemFileHandle,
        )
        cleanup()
        resolve(handles)
      },
      { once: true },
    )
    input.addEventListener(
      'cancel',
      () => {
        cleanup()
        resolve([])
      },
      { once: true },
    )
    document.body.appendChild(input)
    input.click()
  })
}

class BrowserFileHandle {
  readonly kind = 'file' as const
  readonly name: string

  constructor(private readonly file: File) {
    this.name = file.name
  }

  async getFile(): Promise<File> {
    return this.file
  }

  async queryPermission(): Promise<PermissionState> {
    return 'granted'
  }

  async requestPermission(): Promise<PermissionState> {
    return 'granted'
  }

  async isSameEntry(other: FileSystemHandle): Promise<boolean> {
    return other === this
  }
}

function isTauriDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}
