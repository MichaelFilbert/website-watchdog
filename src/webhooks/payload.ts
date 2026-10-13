export interface ChangeNotification {
  changeId: string;
  monitorName: string;
  url: string;
  category: string;
  severity: string;
  summary: string;
  detectedAt: string;
}

const SEVERITY_ICON: Record<string, string> = { high: '[HIGH]', medium: '[MEDIUM]', low: '[LOW]' };

/**
 * Body shape works for Slack incoming webhooks (`text`) and Discord webhooks (`content`);
 * `watchdog` carries the structured fields for any other receiver.
 */
export function buildWebhookBody(n: ChangeNotification): string {
  const line = `${SEVERITY_ICON[n.severity] ?? ''} ${n.monitorName}: ${n.category} change - ${n.summary} (${n.url})`.trim();
  return JSON.stringify({ content: line, text: line, watchdog: n });
}
