import Link from "next/link";

export function AppShell({
  children,
  header,
  className = "",
}: {
  children: React.ReactNode;
  header?: React.ReactNode;
  className?: string;
}) {
  return (
    <main className="page-shell">
      <div className={`mobile-frame ${className}`.trim()}>
        {header}
        {children}
      </div>
    </main>
  );
}

export function MarketingHeader() {
  return (
    <header className="top-header">
      <BrandWordmark />
      <button className="menu-button" aria-label="Open menu" type="button">
        <MenuIcon />
      </button>
    </header>
  );
}

export function MinimalHeader({ backHref }: { backHref?: string }) {
  return (
    <div className="minimal-header">
      {backHref ? (
        <Link aria-label="Go back" className="back-button" href={backHref}>
          <ArrowLeftIcon />
        </Link>
      ) : (
        <span />
      )}
    </div>
  );
}

export function BrandWordmark() {
  return (
    <div className="brand-lockup">
      <LogoMark />
      <span>ORIN</span>
    </div>
  );
}

export function LogoMark() {
  return (
    <img alt="ORIN" className="logo-mark" src="/orin-logo.svg" />
  );
}

export function PrivacyIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="6" y="10" width="12" height="9" rx="2" />
      <path d="M8.5 10V7.8C8.5 5.7 10.18 4 12.25 4C14.32 4 16 5.7 16 7.8V10" />
    </svg>
  );
}

export function DocumentIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 4.5H14L18 8.5V19.5H8V4.5Z" />
      <path d="M14 4.5V8.5H18" />
      <path d="M10 12.2H16" />
      <path d="M10 15.5H14.5" />
    </svg>
  );
}

export function ShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 4.5L18 7V11.5C18 15.4 15.72 18.97 12 20.5C8.28 18.97 6 15.4 6 11.5V7L12 4.5Z" />
    </svg>
  );
}

export function ConsentArt() {
  return (
    <svg className="consent-art" viewBox="0 0 140 90" fill="none" aria-hidden="true">
      <ellipse cx="68" cy="44" rx="41" ry="28" stroke="currentColor" strokeWidth="1.3" />
      <path d="M27 44V61C27 72 45 79 68 79C91 79 109 72 109 61V44" stroke="currentColor" strokeWidth="1.3" />
      <path d="M68 16L93 28.5L68 43L43 28.5L68 16Z" stroke="currentColor" strokeWidth="1.3" />
      <path d="M68 43V78" stroke="currentColor" strokeWidth="1.3" />
      <path d="M43 28.5L68 43L93 28.5" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

export function MailArt() {
  return (
    <svg className="mail-art" viewBox="0 0 120 120" fill="none" aria-hidden="true">
      <circle cx="60" cy="60" r="46" fill="#EFEFEF" />
      <rect x="30" y="42" width="60" height="38" rx="4" fill="white" stroke="#D6D6D6" />
      <path d="M30 47L60 66L90 47" stroke="#A8A8A8" strokeWidth="2" />
      <rect x="45" y="48" width="30" height="8" rx="2" fill="#1F1F1F" />
      <circle cx="43" cy="69" r="4" stroke="#555" />
      <circle cx="77" cy="69" r="4" stroke="#555" />
    </svg>
  );
}

export function SuccessArt() {
  return (
    <svg className="mail-art" viewBox="0 0 120 120" fill="none" aria-hidden="true">
      <circle cx="60" cy="60" r="46" fill="#EFEFEF" />
      <circle cx="60" cy="60" r="26" fill="#55D163" />
      <path d="M47 60.5L56 69L74 51" stroke="white" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MenuIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 7.25H19" />
      <path d="M5 12H19" />
      <path d="M5 16.75H19" />
    </svg>
  );
}

function ArrowLeftIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M15 5L8 12L15 19" />
    </svg>
  );
}
