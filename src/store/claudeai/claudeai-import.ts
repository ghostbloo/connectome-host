/**
 * Provenance recorded by the claude.ai importer alongside each session.
 * Fields are optional because older sessions imported before a given field
 * existed will simply omit it. Callers reading this should treat every
 * property as "may be missing" and provide their own fallbacks.
 *
 * Lives in `{dataDir}/sessions/{id}.import-source.json`, NOT inside the
 * Chronicle store directory. Written once by the importer, never updated.
 */
export interface ImportSource {
  conversationUuid?: string;
  name?: string;
  summary?: string | null;
  /** Original `conv.created_at` from the export. */
  createdAt?: string;
  /** Original `conv.updated_at` from the export. */
  updatedAt?: string;
  /**
   * Participant name assigned to assistant turns at import time. Warmup and
   * conhost both read this so they don't disagree about the agent's identity
   * — disagreement leaves strategy state in the wrong Chronicle namespace
   * and the live agent silently amnesiac.
   */
  agentName?: string;
  originalMessageCount?: number;
  importedMessageCount?: number;
  branched?: boolean;
  importedAt?: string;
}
