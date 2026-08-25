/**
 * Workspace safety service — detects leaked credentials and suspicious env vars
 * within a workspace's environment snapshot.
 */

/** Single guard rule: classifies env KEY names as suspicious. */
export interface EnvGuardRule {
  readonly code: string;
  readonly description: string;
  readonly pattern: RegExp;
}

/** Single leak detection rule: inspects KEY-VALUE pairs for leaks. */
export interface EnvLeakRule {
  readonly code: string;
  readonly name: string;
  readonly description: string;
  readonly check: (env: Record<string, string>) => Array<{ key: string; type: string }>;
}

/** Result of running all guard rules. */
export interface GuardCheckResult {
  safe: boolean;
  guardsChecked: number;
  issues: Array<{ key: string; description: string }>;
}

/** Result of running all leak detection rules. */
export interface LeakDetectionResult {
  safe: boolean;
  scanned: boolean;
  rulesApplied: number;
  leakages: Array<{ key: string; type: string }>;
}

/** The public workspaceSafety service interface. */
export interface WorkspaceSafetyService {
  checkGuards(env: Record<string, string>): GuardCheckResult;
  detectLeaks(env: Record<string, string>): LeakDetectionResult;
}

/* ------------------------------------------------------------------ */
/*  Guard rules                                                       */
/* ------------------------------------------------------------------ */

/** Known patterns for env var names that typically hold credentials. */
const GUARD_RULES: ReadonlyArray<EnvGuardRule> = [
  { code: "cloud_provider_creds", description: "Cloud provider credentials in environment", pattern: /^(AWS_|AZURE_|GCP_)/ },
  { code: "raw_api_keys", description: "Raw API keys in environment", pattern: /^(API_KEY|APIKEY|apikey)/ },
  { code: "secret_keys", description: "Secret keys in environment", pattern: /^(SECRET|SECRET_KEY|SECRETKEY)/ },
  { code: "passwords", description: "Passwords in environment", pattern: /^(PASSWORD|PASS|PWD)/ },
  { code: "private_keys", description: "Private keys in environment", pattern: /^(PRIVATE_KEY|PRIVATEKEY)/ },
  { code: "auth_tokens", description: "Authentication tokens in environment", pattern: /^(TOKEN|AUTH_TOKEN|ACCESS_TOKEN)/ },
  { code: "connection_strings", description: "Payment/database connection strings", pattern: /^(STRIPE|DATABASE_URL|MONGODB)/ },
];

/* ------------------------------------------------------------------ */
/*  Leak detection rules                                              */
/* ------------------------------------------------------------------ */

const KEY_CREDENTIAL_RE = /(?:auth|api|secret|access|private|bearer|token|key|password|passwd|pwd|db_url)/i;

const VALUE_PATTERNS: ReadonlyArray<{ type: string; re: RegExp }> = [
  { type: "openai_key", re: /^sk_[a-zA-Z0-9]{20,}/ },
  { type: "generic_secret", re: /^[A-Za-z0-9_-]{40,}$/ },
];

const LEAK_RULES: ReadonlyArray<EnvLeakRule> = [
  {
    code: "credential_pattern_check",
    name: "Credential Pattern Check",
    description: "Check for known credential patterns in variable names",
    check(env): Array<{ key: string; type: string }> {
      const findings: Array<{ key: string; type: string }> = [];
      for (const [key] of Object.entries(env)) {
        if (KEY_CREDENTIAL_RE.test(key)) {
          findings.push({ key, type: "credential_pattern" });
        }
      }
      return findings;
    },
  },
  {
    code: "value_based_detection",
    name: "Value-based Detection",
    description: "Check for credential-like values",
    check(env): Array<{ key: string; type: string }> {
      const findings: Array<{ key: string; type: string }> = [];
      for (const [key, value] of Object.entries(env)) {
        if (typeof value !== "string") continue;
        for (const rule of VALUE_PATTERNS) {
          if (rule.re.test(value)) {
            findings.push({ key, type: rule.type });
          }
        }
      }
      return findings;
    },
  },
];

/* ------------------------------------------------------------------ */
/*  Service implementation                                             */
/* ------------------------------------------------------------------ */

/** Default singleton — use this for simple usage. */
export const workspaceSafety: WorkspaceSafetyService = {

  /** Run key-based guard rules against an environment snapshot. */
  checkGuards(env): GuardCheckResult {
    const issues: Array<{ key: string; description: string }> = [];
    for (const [key] of Object.entries(env)) {
      for (const rule of GUARD_RULES) {
        if (rule.pattern.test(key)) {
          issues.push({ key, description: rule.description });
          break;
        }
      }
    }
    return { safe: issues.length === 0, guardsChecked: GUARD_RULES.length, issues };
  },

  /** Run leak detection rules against an environment snapshot. */
  detectLeaks(env): LeakDetectionResult {
    let allLeakages: Array<{ key: string; type: string }> = [];
    for (const rule of LEAK_RULES) {
      allLeakages = [...allLeakages, ...rule.check(env)];
    }
    return { scanned: true, rulesApplied: LEAK_RULES.length, leakages: allLeakages, safe: allLeakages.length === 0 };
  },
};
