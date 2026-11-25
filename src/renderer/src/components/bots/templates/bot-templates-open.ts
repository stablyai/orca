import { useAppStore } from '@/store'

/** Opens Bot templates over the app, on `templateId` when given, else on the template it last showed. */
export function openBotTemplates(templateId?: string): void {
  useAppStore.getState().openModal('bot-templates', templateId ? { templateId } : {})
}
