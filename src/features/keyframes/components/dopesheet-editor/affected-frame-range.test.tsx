import { render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vite-plus/test'
import { DopesheetEditor } from './index'

describe('DopesheetEditor affected frame range', () => {
  beforeAll(() => {
    class ResizeObserverMock {
      observe() {}
      disconnect() {}
    }

    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
  })

  it('renders a pointer-transparent clipped band behind classic Edit lanes', () => {
    render(
      <DopesheetEditor
        itemId="item-1"
        keyframesByProperty={{
          rotation: [{ id: 'rotation-1', frame: 40, value: 90, easing: 'linear' }],
        }}
        frameViewport={{ startFrame: -20, endFrame: 180 }}
        totalFrames={100}
        affectedFrameRange={{ fromFrame: 0, toFrame: 100 }}
        presentation="classic"
        width={640}
        height={240}
      />,
    )

    const highlight = screen.getByTestId('dopesheet-affected-frame-range')
    expect(highlight).toHaveAttribute('data-from-frame', '0')
    expect(highlight).toHaveAttribute('data-to-frame', '100')
    expect(highlight).toHaveClass('border-foreground/[0.10]', 'bg-foreground/[0.035]')
    expect(highlight.parentElement).toHaveClass('pointer-events-none', 'overflow-hidden')
  })
})
