// Minimal Home Assistant REST service-call client. Unlike ha-events (a long-lived WebSocket
// subscriber), a service call is a single request/response — no persistent connection needed.

export type CallHomeAssistantServiceParams = {
  baseUrl: string;
  token: string;
  domain: string;
  service: string;
  data: Record<string, unknown>;
  /** Append `?return_response` and parse `service_response` — required for services (like
   * `music_assistant.search`) that declare a non-optional response payload. */
  returnResponse?: boolean;
};

export class HomeAssistantServiceCallError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "HomeAssistantServiceCallError";
    this.status = status;
    this.body = body;
  }
}

export async function callHomeAssistantService(
  params: CallHomeAssistantServiceParams,
): Promise<unknown> {
  const base = `${params.baseUrl.replace(/\/+$/, "")}/api/services/${params.domain}/${params.service}`;
  const url = params.returnResponse ? `${base}?return_response` : base;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params.data),
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new HomeAssistantServiceCallError(
      `Home Assistant service call ${params.domain}.${params.service} failed with status ${response.status}`,
      response.status,
      bodyText,
    );
  }

  if (!bodyText) {
    return null;
  }
  const parsed = JSON.parse(bodyText) as unknown;
  if (
    params.returnResponse &&
    parsed &&
    typeof parsed === "object" &&
    "service_response" in parsed
  ) {
    return (parsed as { service_response: unknown }).service_response;
  }
  return parsed;
}
