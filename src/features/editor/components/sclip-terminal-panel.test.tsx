import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/infrastructure/editor-diagnostics', () => ({ copyEditorDiagnosticReport: vi.fn() }))

import { SclipTerminalPanel } from './sclip-terminal-panel'

type GatewayFrame = Record<string, unknown>

class MockGatewaySocket {
  static instances: MockGatewaySocket[] = []
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3

  readonly sent: GatewayFrame[] = []
  readyState = MockGatewaySocket.CONNECTING
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null

  constructor(readonly url: string) {
    MockGatewaySocket.instances.push(this)
  }

  open(): void {
    this.readyState = MockGatewaySocket.OPEN
    this.onopen?.(new Event('open'))
  }

  send(value: string): void {
    this.sent.push(JSON.parse(value) as GatewayFrame)
  }

  emit(frame: GatewayFrame): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(frame) }))
  }

  close(): void {
    this.readyState = MockGatewaySocket.CLOSED
    this.onclose?.(new CloseEvent('close'))
  }
}

function sentMethod(socket: MockGatewaySocket, method: string): GatewayFrame | undefined {
  return socket.sent.find((request) => request.method === method)
}

describe('SCLIP AI chat prompt path', () => {
  beforeEach(() => {
    MockGatewaySocket.instances = []
    vi.mocked(invoke).mockResolvedValue({ url: 'ws://127.0.0.1:4567/api/ws?token=test' })
    vi.stubGlobal('WebSocket', MockGatewaySocket)
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
  })

  it('submits a talking-head cleanup prompt through the project gateway and renders chronological editor activity', async () => {
    render(<SclipTerminalPanel projectId="project-talking-head" />)

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('get_sclip_agent_gateway', { projectId: 'project-talking-head' }))
    const socket = MockGatewaySocket.instances[0]!
    act(() => socket.open())

    await waitFor(() => expect(sentMethod(socket, 'session.most_recent')).toBeDefined())
    const latest = sentMethod(socket, 'session.most_recent')!
    act(() => socket.emit({ jsonrpc: '2.0', id: latest.id, result: {} }))

    await waitFor(() => expect(sentMethod(socket, 'session.create')).toBeDefined())
    const created = sentMethod(socket, 'session.create')!
    act(() => socket.emit({
      jsonrpc: '2.0',
      id: created.id,
      result: { session_id: 'session-1', messages: [], info: { provider: 'fixture', model: 'sclip-test' } },
    }))

    const input = await screen.findByPlaceholderText('Ask SCLIP to inspect or edit this project…')
    fireEvent.change(input, { target: { value: 'Remove the ums from this talking head.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))

    await waitFor(() => expect(sentMethod(socket, 'prompt.submit')).toMatchObject({
      params: { session_id: 'session-1', text: 'Remove the ums from this talking head.', surface: 'desktop' },
    }))

    act(() => {
      socket.emit({ jsonrpc: '2.0', method: 'event', params: { type: 'message.start', payload: {} } })
      socket.emit({ jsonrpc: '2.0', method: 'event', params: { type: 'reasoning.delta', payload: { text: 'I will inspect the timed script first. ' } } })
      socket.emit({ jsonrpc: '2.0', method: 'event', params: { type: 'tool.start', payload: { tool_id: 'read-script', name: 'video_read_script', args: { project_id: 'project-talking-head' } } } })
      socket.emit({ jsonrpc: '2.0', method: 'event', params: { type: 'tool.complete', payload: { tool_id: 'read-script', name: 'video_read_script', result: { scriptRevision: 'sha256:preview' } } } })
      socket.emit({ jsonrpc: '2.0', method: 'event', params: { type: 'reasoning.delta', payload: { text: 'I found two grounded filler candidates and will preview them.' } } })
      socket.emit({ jsonrpc: '2.0', method: 'event', params: { type: 'message.complete', payload: { text: 'I found two ums. I can preview their exact cuts before changing the timeline.' } } })
    })

    expect(await screen.findByText('I found two ums. I can preview their exact cuts before changing the timeline.')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Thinking and tool activity'))
    expect(screen.getByText('I will inspect the timed script first.')).toBeInTheDocument()
    expect(screen.getByText('Read script')).toBeInTheDocument()
    expect(screen.getByText('I found two grounded filler candidates and will preview them.')).toBeInTheDocument()
  })

  it('submits a semantic-analysis prompt and exposes the map-building tool result in the same chat', async () => {
    render(<SclipTerminalPanel projectId="project-semantic" />)
    await waitFor(() => expect(MockGatewaySocket.instances).toHaveLength(1))
    const socket = MockGatewaySocket.instances[0]!
    act(() => socket.open())
    await waitFor(() => expect(sentMethod(socket, 'session.most_recent')).toBeDefined())
    const latest = sentMethod(socket, 'session.most_recent')!
    act(() => socket.emit({ jsonrpc: '2.0', id: latest.id, result: {} }))
    await waitFor(() => expect(sentMethod(socket, 'session.create')).toBeDefined())
    const created = sentMethod(socket, 'session.create')!
    act(() => socket.emit({ jsonrpc: '2.0', id: created.id, result: { session_id: 'semantic-session', messages: [] } }))

    fireEvent.change(await screen.findByPlaceholderText('Ask SCLIP to inspect or edit this project…'), {
      target: { value: 'Find repeated takes and topic changes in this talking head.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(sentMethod(socket, 'prompt.submit')).toMatchObject({
      params: { session_id: 'semantic-session', text: 'Find repeated takes and topic changes in this talking head.' },
    }))

    act(() => {
      socket.emit({ jsonrpc: '2.0', method: 'event', params: { type: 'message.start', payload: {} } })
      socket.emit({ jsonrpc: '2.0', method: 'event', params: { type: 'tool.start', payload: { tool_id: 'semantic-map', name: 'video_build_semantic_map', args: { project_id: 'project-semantic', media_id: 'media-1' } } } })
      socket.emit({ jsonrpc: '2.0', method: 'event', params: { type: 'tool.complete', payload: { tool_id: 'semantic-map', name: 'video_build_semantic_map', result: { reviewCandidates: [{ kind: 'retake_candidate' }, { kind: 'topic_transition' }] } } } })
      socket.emit({ jsonrpc: '2.0', method: 'event', params: { type: 'message.complete', payload: { text: 'I found one repeated-take candidate and two topic-transition candidates. These are suggestions, not cuts.' } } })
    })

    expect(await screen.findByText('I found one repeated-take candidate and two topic-transition candidates. These are suggestions, not cuts.')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Thinking and tool activity'))
    expect(screen.getByText('Build semantic map')).toBeInTheDocument()
  })

  it('submits a rough-cut request and renders proposal planning before any edit is applied', async () => {
    render(<SclipTerminalPanel projectId="project-rough-cut" />)
    await waitFor(() => expect(MockGatewaySocket.instances).toHaveLength(1))
    const socket = MockGatewaySocket.instances[0]!
    act(() => socket.open())
    await waitFor(() => expect(sentMethod(socket, 'session.most_recent')).toBeDefined())
    const latest = sentMethod(socket, 'session.most_recent')!
    act(() => socket.emit({ jsonrpc: '2.0', id: latest.id, result: {} }))
    await waitFor(() => expect(sentMethod(socket, 'session.create')).toBeDefined())
    const created = sentMethod(socket, 'session.create')!
    act(() => socket.emit({ jsonrpc: '2.0', id: created.id, result: { session_id: 'rough-cut-session', messages: [] } }))

    fireEvent.change(await screen.findByPlaceholderText('Ask SCLIP to inspect or edit this project…'), {
      target: { value: 'Make a tighter rough cut of this talking head and show me the plan first.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(sentMethod(socket, 'prompt.submit')).toMatchObject({
      params: { session_id: 'rough-cut-session', text: 'Make a tighter rough cut of this talking head and show me the plan first.' },
    }))

    act(() => {
      socket.emit({ jsonrpc: '2.0', method: 'event', params: { type: 'message.start', payload: {} } })
      socket.emit({ jsonrpc: '2.0', method: 'event', params: { type: 'reasoning.delta', payload: { text: 'I will make a reviewable proposal before changing the timeline. ' } } })
      socket.emit({ jsonrpc: '2.0', method: 'event', params: { type: 'tool.start', payload: { tool_id: 'rough-cut', name: 'video_rough_cut_proposal', args: { project_id: 'project-rough-cut', action: 'save' } } } })
      socket.emit({ jsonrpc: '2.0', method: 'event', params: { type: 'tool.complete', payload: { tool_id: 'rough-cut', name: 'video_rough_cut_proposal', result: { applied: false, proposalId: 'proposal-1', preview: [{ type: 'remove_words' }] } } } })
      socket.emit({ jsonrpc: '2.0', method: 'event', params: { type: 'message.complete', payload: { text: 'I saved a reviewable rough-cut proposal. Nothing has been changed; I will show the exact removals before applying it.' } } })
    })

    expect(await screen.findByText('I saved a reviewable rough-cut proposal. Nothing has been changed; I will show the exact removals before applying it.')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Thinking and tool activity'))
    expect(screen.getByText('Rough cut proposal')).toBeInTheDocument()
  })

  it('submits a delivery request and exposes captions, composed review, and render steps in order', async () => {
    render(<SclipTerminalPanel projectId="project-delivery" />)
    await waitFor(() => expect(MockGatewaySocket.instances).toHaveLength(1))
    const socket = MockGatewaySocket.instances[0]!
    act(() => socket.open())
    await waitFor(() => expect(sentMethod(socket, 'session.most_recent')).toBeDefined())
    const latest = sentMethod(socket, 'session.most_recent')!
    act(() => socket.emit({ jsonrpc: '2.0', id: latest.id, result: {} }))
    await waitFor(() => expect(sentMethod(socket, 'session.create')).toBeDefined())
    const created = sentMethod(socket, 'session.create')!
    act(() => socket.emit({ jsonrpc: '2.0', id: created.id, result: { session_id: 'delivery-session', messages: [] } }))

    fireEvent.change(await screen.findByPlaceholderText('Ask SCLIP to inspect or edit this project…'), {
      target: { value: 'Add captions, check the finished preview, and export a ready-to-post version.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(sentMethod(socket, 'prompt.submit')).toMatchObject({
      params: { session_id: 'delivery-session', text: 'Add captions, check the finished preview, and export a ready-to-post version.' },
    }))

    act(() => {
      socket.emit({ jsonrpc: '2.0', method: 'event', params: { type: 'message.start', payload: {} } })
      socket.emit({ jsonrpc: '2.0', method: 'event', params: { type: 'tool.start', payload: { tool_id: 'captions', name: 'video_transcribe' } } })
      socket.emit({ jsonrpc: '2.0', method: 'event', params: { type: 'tool.complete', payload: { tool_id: 'captions', name: 'video_transcribe', result: { transcriptAvailable: true } } } })
      socket.emit({ jsonrpc: '2.0', method: 'event', params: { type: 'tool.start', payload: { tool_id: 'preview', name: 'video_review_preview' } } })
      socket.emit({ jsonrpc: '2.0', method: 'event', params: { type: 'tool.complete', payload: { tool_id: 'preview', name: 'video_review_preview', result: { visualVerification: { status: 'verified' } } } } })
      socket.emit({ jsonrpc: '2.0', method: 'event', params: { type: 'tool.start', payload: { tool_id: 'render', name: 'video_render' } } })
      socket.emit({ jsonrpc: '2.0', method: 'event', params: { type: 'tool.complete', payload: { tool_id: 'render', name: 'video_render', result: { status: 'queued' } } } })
      socket.emit({ jsonrpc: '2.0', method: 'event', params: { type: 'message.complete', payload: { text: 'Captions are added, the composed preview was checked, and the export is queued.' } } })
    })

    expect(await screen.findByText('Captions are added, the composed preview was checked, and the export is queued.')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Thinking and tool activity'))
    expect(screen.getByText('Transcribe')).toBeInTheDocument()
    expect(screen.getByText('Review preview')).toBeInTheDocument()
    expect(screen.getByText('Render')).toBeInTheDocument()
  })

  it('submits a visual-inspection request and distinguishes source analysis from the composed preview', async () => {
    render(<SclipTerminalPanel projectId="project-perception" />)
    await waitFor(() => expect(MockGatewaySocket.instances).toHaveLength(1))
    const socket = MockGatewaySocket.instances[0]!
    act(() => socket.open())
    await waitFor(() => expect(sentMethod(socket, 'session.most_recent')).toBeDefined())
    const latest = sentMethod(socket, 'session.most_recent')!
    act(() => socket.emit({ jsonrpc: '2.0', id: latest.id, result: {} }))
    await waitFor(() => expect(sentMethod(socket, 'session.create')).toBeDefined())
    const created = sentMethod(socket, 'session.create')!
    act(() => socket.emit({ jsonrpc: '2.0', id: created.id, result: { session_id: 'perception-session', messages: [] } }))

    fireEvent.change(await screen.findByPlaceholderText('Ask SCLIP to inspect or edit this project…'), {
      target: { value: 'Look at the source footage and then verify what the audience sees in the edit.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(sentMethod(socket, 'prompt.submit')).toMatchObject({
      params: { session_id: 'perception-session', text: 'Look at the source footage and then verify what the audience sees in the edit.' },
    }))

    act(() => {
      socket.emit({ jsonrpc: '2.0', method: 'event', params: { type: 'message.start', payload: {} } })
      socket.emit({ jsonrpc: '2.0', method: 'event', params: { type: 'tool.start', payload: { tool_id: 'source', name: 'video_understand' } } })
      socket.emit({ jsonrpc: '2.0', method: 'event', params: { type: 'tool.complete', payload: { tool_id: 'source', name: 'video_understand', result: { sceneCount: 4 } } } })
      socket.emit({ jsonrpc: '2.0', method: 'event', params: { type: 'tool.start', payload: { tool_id: 'composed', name: 'video_review_preview' } } })
      socket.emit({ jsonrpc: '2.0', method: 'event', params: { type: 'tool.complete', payload: { tool_id: 'composed', name: 'video_review_preview', result: { evidence: { pixelsAnalyzed: true, projectRevision: 'sha256:revision' } } } } })
      socket.emit({ jsonrpc: '2.0', method: 'event', params: { type: 'message.complete', payload: { text: 'I inspected the source and separately verified the captured composited preview for this revision.' } } })
    })

    expect(await screen.findByText('I inspected the source and separately verified the captured composited preview for this revision.')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Thinking and tool activity'))
    expect(screen.getByText('Understand')).toBeInTheDocument()
    expect(screen.getByText('Review preview')).toBeInTheDocument()
  })

  it('submits a local B-roll request and presents evidence-backed media search before placement', async () => {
    render(<SclipTerminalPanel projectId="project-broll" />)
    await waitFor(() => expect(MockGatewaySocket.instances).toHaveLength(1))
    const socket = MockGatewaySocket.instances[0]!
    act(() => socket.open())
    await waitFor(() => expect(sentMethod(socket, 'session.most_recent')).toBeDefined())
    const latest = sentMethod(socket, 'session.most_recent')!
    act(() => socket.emit({ jsonrpc: '2.0', id: latest.id, result: {} }))
    await waitFor(() => expect(sentMethod(socket, 'session.create')).toBeDefined())
    const created = sentMethod(socket, 'session.create')!
    act(() => socket.emit({ jsonrpc: '2.0', id: created.id, result: { session_id: 'broll-session', messages: [] } }))

    fireEvent.change(await screen.findByPlaceholderText('Ask SCLIP to inspect or edit this project…'), {
      target: { value: 'Find local B-roll of a football stadium, but show me the matching evidence before using it.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(sentMethod(socket, 'prompt.submit')).toMatchObject({
      params: { session_id: 'broll-session', text: 'Find local B-roll of a football stadium, but show me the matching evidence before using it.' },
    }))

    act(() => {
      socket.emit({ jsonrpc: '2.0', method: 'event', params: { type: 'message.start', payload: {} } })
      socket.emit({ jsonrpc: '2.0', method: 'event', params: { type: 'tool.start', payload: { tool_id: 'local-search', name: 'video_search_media' } } })
      socket.emit({ jsonrpc: '2.0', method: 'event', params: { type: 'tool.complete', payload: { tool_id: 'local-search', name: 'video_search_media', result: { resultCount: 1, results: [{ evidence: [{ source: 'visual_caption', timeSec: 3.2 }] }] } } } })
      socket.emit({ jsonrpc: '2.0', method: 'event', params: { type: 'message.complete', payload: { text: 'I found one local candidate with a timestamped visual-caption match. I have not placed it on the timeline.' } } })
    })

    expect(await screen.findByText('I found one local candidate with a timestamped visual-caption match. I have not placed it on the timeline.')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Thinking and tool activity'))
    expect(screen.getByText('Search media')).toBeInTheDocument()
  })

  it('submits an explicit style preference and records it through SCLIP editing memory', async () => {
    render(<SclipTerminalPanel projectId="project-style" />)
    await waitFor(() => expect(MockGatewaySocket.instances).toHaveLength(1))
    const socket = MockGatewaySocket.instances[0]!
    act(() => socket.open())
    await waitFor(() => expect(sentMethod(socket, 'session.most_recent')).toBeDefined())
    const latest = sentMethod(socket, 'session.most_recent')!
    act(() => socket.emit({ jsonrpc: '2.0', id: latest.id, result: {} }))
    await waitFor(() => expect(sentMethod(socket, 'session.create')).toBeDefined())
    const created = sentMethod(socket, 'session.create')!
    act(() => socket.emit({ jsonrpc: '2.0', id: created.id, result: { session_id: 'style-session', messages: [] } }))

    fireEvent.change(await screen.findByPlaceholderText('Ask SCLIP to inspect or edit this project…'), {
      target: { value: 'Remember that I prefer concise captions and no background music unless I ask for it.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
    await waitFor(() => expect(sentMethod(socket, 'prompt.submit')).toMatchObject({
      params: { session_id: 'style-session', text: 'Remember that I prefer concise captions and no background music unless I ask for it.' },
    }))

    act(() => {
      socket.emit({ jsonrpc: '2.0', method: 'event', params: { type: 'message.start', payload: {} } })
      socket.emit({ jsonrpc: '2.0', method: 'event', params: { type: 'tool.start', payload: { tool_id: 'memory', name: 'video_editing_memory', args: { action: 'update_preferences' } } } })
      socket.emit({ jsonrpc: '2.0', method: 'event', params: { type: 'tool.complete', payload: { tool_id: 'memory', name: 'video_editing_memory', result: { success: true } } } })
      socket.emit({ jsonrpc: '2.0', method: 'event', params: { type: 'message.complete', payload: { text: 'I saved those as explicit SCLIP editing preferences on this Mac.' } } })
    })

    expect(await screen.findByText('I saved those as explicit SCLIP editing preferences on this Mac.')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Thinking and tool activity'))
    expect(screen.getByText('Editing memory')).toBeInTheDocument()
  })
})
