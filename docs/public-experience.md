# SignalGrid public experience

The public journey now follows the approved light visual direction:

`Landing → Sign In → Authenticated Overview`

## Landing

`/` is a single, full-viewport hero with a near-white canvas, the reusable document-and-chart SignalGrid mark, an orange Sign In action, and the exact mission statement:

```text
Every Report.
Every Risk.
In View.
```

The supporting sentence is source-approved copy: “One clear workspace for report health, alerts, investigations, and costs.” The workflow strip below it is a reusable SVG timeline with Monitor, Detect, Investigate and Understand stages. Its restrained illumination loop is illustrative only; it does not claim live counts or fabricated telemetry.

## Sign in

`/signin` reuses the mission and signal timeline in a light two-column layout. The right-hand card uses the real Express session endpoint, accessible labels, password visibility, loading/error states, and a Back to home action. When `SIGNALGRID_DEMO_AUTH=true`, the card discreetly lists the three demonstration accounts:

- Administrator: `admin` / `admin123`
- Owner: `user` / `user123`
- Analyst: `analyst` / `analyst123`

These credentials are never shown on the public landing hero and are not runtime secrets.

## Shared brand

`SignalGridLogo` is an inline SVG React component with full and compact variants. The matching `/assets/signalgrid-logo.svg` is used as the favicon. The component is reused by the public header, authenticated sidebar, and loading state. Onest is loaded from the bundled `@fontsource-variable/onest` package and assigned through `--font-sans`.

The authenticated dashboard remains the existing source-backed light operational workspace. Its routes, RBAC, replay controls, SSE activity, RCA display and cost calculations were not redesigned in this pass; only shared branding was updated.

## Verification evidence

Browser screenshots are stored in `docs/screenshots/`:

- `landing-light-final.png`
- `signin-light-final.png`
- `dashboard-light-brand-final.png`
- `dashboard-light-standard-user-final.png`

The captured in-app browser viewport was 1,280 × 720 CSS pixels and had no horizontal overflow. Responsive breakpoints for tablet and mobile stacking remain in `apps/web/src/styles.css`.
