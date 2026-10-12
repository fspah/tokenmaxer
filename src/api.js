// The three Anthropic OAuth endpoints Claude Code itself uses (values from Claude Code 2.1.296).
// CT_ANTHROPIC_BASE points everything at a fake server for tests.
const TEST_BASE = process.env.CT_ANTHROPIC_BASE;
const API_BASE = TEST_BASE || 'https://api.anthropic.com';
const TOKEN_URL = TEST_BASE ? `${TEST_BASE}/v1/oauth/token` : 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_BETA = 'oauth-2025-04-20';
const USER_AGENT = 'claude-control-tower/0.1';

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code; // 'invalid_grant' when a refresh token is dead
  }
}

async function request(url, init) {
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
  } catch (err) {
    throw new ApiError(`Network error: ${err.cause?.code || err.message}`, 0, 'network');
  }
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    const code = body?.error?.type || (typeof body?.error === 'string' ? body.error : undefined);
    throw new ApiError(`Anthropic returned HTTP ${res.status}${code === 'invalid_grant' ? ': login expired' : ''}.`, res.status, code);
  }
  if (!body || typeof body !== 'object') throw new ApiError('Anthropic returned an invalid response.', res.status, 'invalid_response');
  return body;
}

function bearer(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'anthropic-beta': OAUTH_BETA,
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
  };
}

export function fetchUsage(accessToken) {
  return request(`${API_BASE}/api/oauth/usage`, { headers: bearer(accessToken) });
}

export function fetchProfile(accessToken) {
  return request(`${API_BASE}/api/oauth/profile`, { headers: { ...bearer(accessToken), 'Cache-Control': 'no-cache' } });
}

// Returns { tokens, accountUuid, organizationUuid }; tokens is a claudeAiOauth object in the exact
// shape Claude Code stores. The token endpoint also says which account the grant belongs to.
export async function refreshTokens(tokens) {
  const body = await request(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
      client_id: tokens.clientId ?? CLIENT_ID,
      scope: (tokens.scopes ?? []).join(' '),
    }),
  });
  const now = Date.now();
  if (typeof body.access_token !== 'string' || !body.access_token || !Number.isFinite(body.expires_in) || body.expires_in <= 0) {
    throw new ApiError('Anthropic returned invalid refreshed credentials.', 200, 'invalid_response');
  }
  const next = {
    ...tokens,
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? tokens.refreshToken,
    expiresAt: now + body.expires_in * 1000,
    refreshTokenExpiresAt: body.refresh_token_expires_in ? now + body.refresh_token_expires_in * 1000 : tokens.refreshTokenExpiresAt,
    scopes: body.scope ? body.scope.split(' ').filter(Boolean) : tokens.scopes,
    subscriptionType: tokens.subscriptionType ?? null,
    rateLimitTier: tokens.rateLimitTier ?? null,
  };
  if (tokens.clientId) next.clientId = tokens.clientId;
  return { tokens: next, accountUuid: body.account?.uuid, organizationUuid: body.organization?.uuid };
}
