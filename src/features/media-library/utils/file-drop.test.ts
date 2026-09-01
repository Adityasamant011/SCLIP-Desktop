// @vitest-environment node

import { describe, expect, it, vi } from 'vite-plus/test'
import {
  extractValidMediaFileEntriesFromDataTransfer,
  formatMediaDropRejectionMessage,
} from './file-drop'

function makeItem(handle: FileSystemHandle | null): DataTransferItem {
  return {
    getAsFileSystemHandle: vi.fn().mockResolvedValue(handle),
  } as unknown as DataTransferItem
}

describe('extractValidMediaFileEntriesFromDataTransfer', () => {
  it('falls back to ordinary dropped Files when File System Access handles are unavailable', async () => {
    const file = {
      name: 'clip.mp4',
      size: 12,
      type: 'video/mp4',
      arrayBuffer: vi.fn(),
    } as unknown as File
    const dataTransfer = {
      items: [{}],
      files: [file],
    } as unknown as DataTransfer

    const result = await extractValidMediaFileEntriesFromDataTransfer(dataTransfer)

    expect(result.supported).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.entries).toHaveLength(1)
    expect(await result.entries[0]!.handle.getFile()).toBe(file)
    expect(await result.entries[0]!.handle.queryPermission({ mode: 'read' })).toBe('granted')
  })

  it('reports dropped folders instead of silently ignoring them', async () => {
    const directoryHandle = {
      kind: 'directory',
      name: 'Media Folder',
    } as unknown as FileSystemDirectoryHandle
    const dataTransfer = {
      items: [makeItem(directoryHandle)],
    } as unknown as DataTransfer

    const result = await extractValidMediaFileEntriesFromDataTransfer(dataTransfer)

    expect(result.supported).toBe(true)
    expect(result.entries).toEqual([])
    expect(result.errors).toEqual([
      'Media Folder: folders are not supported yet. Drop media files directly.',
    ])
  })
})

describe('formatMediaDropRejectionMessage', () => {
  it('summarizes rejected drops with examples and an overflow count', () => {
    expect(
      formatMediaDropRejectionMessage([
        'folder: folders are not supported yet. Drop media files directly.',
        'notes.txt: Unsupported file type',
        'archive.zip: Unsupported file type',
        'broken.mp4: Unable to read file',
      ]),
    ).toBe(
      '4 dropped items were rejected: folder: folders are not supported yet. Drop media files directly.; notes.txt: Unsupported file type; archive.zip: Unsupported file type; and 1 more.',
    )
  })
})
