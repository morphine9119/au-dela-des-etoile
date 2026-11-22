export const SUPPORT_STATUS_MESSAGES = {
  in_progress: 'Votre ticket est actuellement en cours d’examen par notre équipe de support',
  resolved: 'Votre demande a été marquée comme résolue par notre équipe',
  closed: 'Votre demande a été clôturée par notre équipe',
} as const;

export function supportStatusBadgeClass(status: string): string {
  if (status === 'new' || status === 'in_progress') return 'bg-[#101323]';
  if (status === 'open' || status === 'resolved') return 'bg-green-600';
  if (status === 'waiting_customer') return 'bg-orange-500';
  if (status === 'closed') return 'bg-red-600';
  return 'bg-[#64667A]';
}

export function supportStatusMessageClass(content: string): string | undefined {
  if (content === SUPPORT_STATUS_MESSAGES.in_progress) {
    return 'border-orange-200 bg-orange-50 text-orange-700';
  }
  if (content === SUPPORT_STATUS_MESSAGES.resolved) {
    return 'border-green-200 bg-green-50 text-green-700';
  }
  if (content === SUPPORT_STATUS_MESSAGES.closed) {
    return 'border-red-200 bg-red-50 text-red-700';
  }
  return undefined;
}
