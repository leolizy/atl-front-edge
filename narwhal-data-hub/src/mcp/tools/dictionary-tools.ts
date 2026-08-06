import { z } from "zod/v4";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DictionaryGenerator } from "../../dictionary/dictionary-generator.js";

/**
 * Register all dictionary-related tools and resources on the given MCP server.
 *
 * Tools:
 *   - lookup_term(term)        → { match, layer, definition, see_also[], uri }
 *   - search_dictionary(query) → { results[], total }
 *
 * Resources:
 *   - dict://cdm/{type_name}       — CDM type definition
 *   - dict://ext/{field_name}      — extension field definition
 *   - dict://lineage/{cdm_path}    — source→CDM lineage
 *   - dict://alias/{term}          — alias → canonical field mapping
 */
export function registerDictionary(
  server: McpServer,
  dict: DictionaryGenerator
): void {
  // ── Tools ────────────────────────────────────────────────────────────────

  server.registerTool(
    "lookup_term",
    {
      description:
        "Look up a term in the dictionary across all four layers (aliases, CDM types, extensions, lineage). Alias expansion: 'ticker' resolves to the canonical field via the alias map.",
      inputSchema: z.object({
        term: z.string().describe("The term to look up"),
      }),
    },
    async ({ term }) => {
      const result = dict.lookupTerm(term);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              result ?? { error: `No entry found for term '${term}'` },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.registerTool(
    "search_dictionary",
    {
      description:
        "Free-text search across all four dictionary layers. Case-insensitive substring matching on term and definition.",
      inputSchema: z.object({
        query: z.string().describe("Search query string"),
      }),
    },
    async ({ query }) => {
      const result = dict.searchDictionary(query);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  // ── Resources ────────────────────────────────────────────────────────────

  // dict://cdm/{type_name}
  server.registerResource(
    "cdm-type",
    new ResourceTemplate("dict://cdm/{type_name}", { list: undefined }),
    {
      description:
        "Verbatim CDM type definition from pinned release (FINOS CDM 5.0.0)",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const typeName = variables.type_name as string;
      const entry = dict.getCdmType(typeName);

      if (!entry) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify({
                error: `CDM type '${typeName}' not found`,
              }),
            },
          ],
        };
      }

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(entry, null, 2),
          },
        ],
      };
    }
  );

  // dict://ext/{field_name}
  server.registerResource(
    "ext-field",
    new ResourceTemplate("dict://ext/{field_name}", { list: undefined }),
    {
      description:
        "Extension field definition (MIC, board lot, tick size, etc.)",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const fieldName = variables.field_name as string;
      const entry = dict.getExtension(fieldName);

      if (!entry) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify({
                error: `Extension field '${fieldName}' not found`,
              }),
            },
          ],
        };
      }

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(entry, null, 2),
          },
        ],
      };
    }
  );

  // dict://lineage/{cdm_path}
  server.registerResource(
    "lineage",
    new ResourceTemplate("dict://lineage/{cdm_path}", { list: undefined }),
    {
      description:
        "Source→CDM lineage: which venue file columns map to this CDM path",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const cdmPath = variables.cdm_path as string;
      const entries = dict.getLineage(cdmPath);

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(
              entries.length > 0
                ? { cdm_path: cdmPath, sources: entries }
                : { error: `No lineage entries for CDM path '${cdmPath}'` },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // dict://alias/{term}
  server.registerResource(
    "alias",
    new ResourceTemplate("dict://alias/{term}", { list: undefined }),
    {
      description: "Alias → canonical field mapping",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const term = variables.term as string;
      const entry = dict.getAlias(term);

      if (!entry) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify({
                error: `No alias found for term '${term}'`,
              }),
            },
          ],
        };
      }

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(entry, null, 2),
          },
        ],
      };
    }
  );
}
