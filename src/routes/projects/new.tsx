import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { createLogger } from '@/shared/logging/logger'
import { InlineCreateProjectForm } from '@/features/projects/components/project-form'
import { useCreateProject } from '@/features/projects/hooks/use-project-actions'
import { useProjectStore } from '@/features/projects/stores/project-store'
import { SclipLogo } from '@/components/brand/sclip-logo'
import type { ProjectFormData } from '@/features/projects/utils/validation'

const logger = createLogger('NewProject')

export const Route = createFileRoute('/projects/new')({
  component: NewProject,
  beforeLoad: async () => {
    try {
      const { loadProjects } = useProjectStore.getState()
      await loadProjects()
    } catch (err) {
      logger.warn('Failed to pre-load projects in beforeLoad:', err)
    }
  },
})

function NewProject() {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const createProject = useCreateProject()

  const handleSubmit = async (data: ProjectFormData) => {
    setIsSubmitting(true)

    try {
      const result = await createProject(data)

      if (result.success && result.project) {
        // Navigate to editor with new project
        navigate({
          to: '/editor/$projectId',
          params: { projectId: result.project.id },
        })
      } else {
        toast.error(t('projects.toasts.createFailed'), { description: result.error })
        setIsSubmitting(false)
      }
    } catch (error) {
      logger.error('Failed to create project:', error)
      toast.error(t('projects.toasts.createFailed'), { description: t('projects.tryAgain') })
      setIsSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="panel-header border-b border-border">
        <div className="max-w-7xl mx-auto px-6 py-5 flex items-center justify-between">
          <Link to="/">
            <SclipLogo variant="full" size="md" className="hover:opacity-80 transition-opacity" />
          </Link>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-7xl mx-auto px-6 py-8">
        <InlineCreateProjectForm onSubmit={handleSubmit} isSubmitting={isSubmitting} />
      </div>
    </div>
  )
}
