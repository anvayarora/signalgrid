import { randomBytes } from "node:crypto";
import type { Role } from "./types.js";

export type AuthUser = { username: string; role: Role };
type Session = { user: AuthUser; expiresAt: number };
type SseTicket = { user: AuthUser; expiresAt: number; sessionToken?: string };
export type SseAuthorization = { user: AuthUser; sessionToken?: string };

type AuthOptions = { ttlMs?: number; ticketTtlMs?: number; demoAuthEnabled?: boolean };

function canonicalRole(role: Role): Role {
  // VIEWER was emitted by an earlier demo build. Treat it as the least
  // privileged OWNER scope during migration; it must never regain the old
  // platform-wide read path.
  return role === "VIEWER" ? "OWNER" : role;
}

function canonicalUser(user: AuthUser): AuthUser {
  return { ...user, role: canonicalRole(user.role) };
}

export class AuthService {
  private sessions = new Map<string, Session>();
  private tickets = new Map<string, SseTicket>();
  private readonly ttlMs: number;
  private readonly ticketTtlMs: number;
  private readonly demoAuthEnabled: boolean;

  constructor(options: AuthOptions = {}) {
    const configuredTtl = Number(options.ttlMs ?? process.env.AUTH_TOKEN_TTL_MS ?? 3_600_000);
    const configuredTicketTtl = Number(options.ticketTtlMs ?? process.env.SSE_TICKET_TTL_MS ?? 60_000);
    this.ttlMs = Number.isFinite(configuredTtl) && configuredTtl > 0 ? configuredTtl : 3_600_000;
    this.ticketTtlMs = Number.isFinite(configuredTicketTtl) && configuredTicketTtl > 0 ? configuredTicketTtl : 60_000;
    const configuredDemoAuth = process.env.SIGNALGRID_DEMO_AUTH?.trim().toLowerCase();
    const privatePasswordsConfigured = Boolean(
      process.env.SIGNALGRID_ADMIN_PASSWORD ||
      process.env.SIGNALGRID_VIEWER_PASSWORD ||
      process.env.SIGNALGRID_ANALYST_PASSWORD,
    );
    // A bare local checkout should be immediately usable with the documented
    // demo accounts. Production/private deployments must opt out explicitly,
    // or provide private passwords, so predictable demo credentials are never
    // enabled accidentally when a real password configuration is present.
    const defaultDemoAuth = configuredDemoAuth === undefined ? !privatePasswordsConfigured : configuredDemoAuth === "true";
    this.demoAuthEnabled = options.demoAuthEnabled ?? defaultDemoAuth;
  }

  isDemoAuthEnabled() { return this.demoAuthEnabled; }

  login(username: string, password: string): { token: string; user: AuthUser; expiresAt: number } | null {
    let role: Role | null = null;
    if (this.demoAuthEnabled) {
      if (username === "admin" && password === "admin123") role = "ADMIN";
      if (username === "user" && password === "user123") role = "OWNER";
      if (username === "analyst" && password === "analyst123") role = "ANALYST";
    } else {
      const expected = username === "admin" ? process.env.SIGNALGRID_ADMIN_PASSWORD : username === "viewer" || username === "user" ? process.env.SIGNALGRID_VIEWER_PASSWORD : username === "analyst" ? process.env.SIGNALGRID_ANALYST_PASSWORD : null;
      if (expected && password === expected) role = username === "admin" ? "ADMIN" : username === "analyst" ? "ANALYST" : "OWNER";
    }
    if (!role) return null;
    return this.issue({ username, role });
  }

  issue(user: AuthUser) {
    user = canonicalUser(user);
    const token = randomBytes(24).toString("hex"); const expiresAt = Date.now() + this.ttlMs;
    this.sessions.set(token, { user, expiresAt });
    return { token, user, expiresAt };
  }

  authorizeBearer(token: string | undefined): AuthUser | undefined {
    if (!token) return undefined;
    const session = this.sessions.get(token);
    if (!session || session.expiresAt <= Date.now()) { this.sessions.delete(token); return undefined; }
    session.user = canonicalUser(session.user);
    return session.user;
  }

  revoke(token: string | undefined) {
    if (!token) return false;
    const removed = this.sessions.delete(token);
    for (const [ticket, session] of this.tickets) if (session.sessionToken === token) this.tickets.delete(ticket);
    return removed;
  }

  issueSseTicket(user: AuthUser, sessionToken?: string) {
    user = canonicalUser(user);
    const ticket = randomBytes(24).toString("hex"); const expiresAt = Date.now() + this.ticketTtlMs;
    this.tickets.set(ticket, { user, expiresAt, sessionToken });
    return { ticket, expiresAt };
  }

  authorizeSseTicket(ticket: string | undefined): AuthUser | undefined {
    return this.authorizeSseTicketDetails(ticket)?.user;
  }

  authorizeSseTicketDetails(ticket: string | undefined): SseAuthorization | undefined {
    if (!ticket) return undefined;
    const session = this.tickets.get(ticket);
    if (!session || session.expiresAt <= Date.now()) { this.tickets.delete(ticket); return undefined; }
    if (session.sessionToken && !this.authorizeBearer(session.sessionToken)) { this.tickets.delete(ticket); return undefined; }
    session.user = canonicalUser(session.user);
    return { user: session.user, sessionToken: session.sessionToken };
  }
}

