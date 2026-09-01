import { cn } from '@/shared/ui/cn'

interface SclipLogoProps {
  variant?: 'full' | 'icon'
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

const sizeConfig = {
  sm: { icon: 'h-5 w-5', text: 'text-base', gap: 'gap-1.5' },
  md: { icon: 'h-7 w-7', text: 'text-xl', gap: 'gap-2' },
  lg: { icon: 'h-10 w-10', text: 'text-3xl', gap: 'gap-3' },
}

export function SclipLogo({ variant = 'full', size = 'md', className }: SclipLogoProps) {
  const config = sizeConfig[size]
  const mark = (
    <img
      src="/brand/sclip-mark.png"
      alt=""
      aria-hidden="true"
      className={cn(config.icon, 'shrink-0 rounded-[22%] object-cover')}
    />
  )

  if (variant === 'icon') return <span className={className}>{mark}</span>

  return (
    <div className={cn('flex items-center', config.gap, className)}>
      {mark}
      <span className={cn(config.text, 'font-semibold tracking-tight text-foreground')}>SCLIP</span>
    </div>
  )
}
