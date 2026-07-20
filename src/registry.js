// ── Tool Definitions ─────────────────────────────────────────────────────────
// Design: Few focused tools that cover all use cases. The LLM has the metadata
// in its system prompt, so it knows IDs. Tools handle URL construction properly.

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'dhis2_query',
      description: `Execute a DHIS2 API query. Supports all HTTP methods and any endpoint.
Base URL and auth are handled automatically. The path must NOT start with /api/{version}/.
IMPORTANT path construction rules:
- Tracker entities: tracker/trackedEntities?program={id}&orgUnit={id}&fields=trackedEntity,attributes[attribute,value]&pageSize=50&totalPages=true
- Tracker events: tracker/events?program={id}&programStage={id}&orgUnit={id}&fields=event,occurredAt,dataValues[dataElement,value]&pageSize=50&totalPages=true
- Tracker enrollments: tracker/enrollments?program={id}&orgUnit={id}&totalPages=true&pageSize=1 (for counting)
- Tracker writes: use tracker?async=false&importStrategy=CREATE|UPDATE|CREATE_AND_UPDATE|DELETE with bundle body {"events":[...]}, {"trackedEntities":[...]}, or {"enrollments":[...]}
- Create enrollment+events in ONE call: nest events inside enrollment object in the "enrollments" array.
- Enrollment UPDATE requires: enrollment, trackedEntity, program, orgUnit, enrolledAt, status. Missing enrolledAt→error.
- Only ONE active enrollment per program per TEI. Create COMPLETED enrollments freely; for new ACTIVE, complete existing first.
- Non-repeatable stage with existing event→UPDATE the event, do NOT create a new one (error E1039).
- Do NOT POST to tracker/events or tracker/trackedEntities directly for writes; those are read endpoints on this server. If you do, the tool will rewrite to tracker bundle format automatically.
- Event analytics aggregate: analytics/events/aggregate/{programId}?dimension=ou:{ouId}&stage={stageId}&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
- Event analytics query: analytics/events/query/{programId}?dimension=ou:{ouId}&stage={stageId}&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&pageSize=100
- Aggregate analytics: analytics?dimension=dx:{deId}&dimension=pe:{period}&dimension=ou:{ouId}
- Metadata list: {type}?fields=id,displayName&paging=false (for small types like dataElements, orgUnits, etc. — NOT for programIndicators or programRules)
- ⚠️ NEVER use paging=false for programIndicators or programRules — use manage_program_indicators / manage_program_rules instead
- Icon search: icons?search={keyword}&fields=key,keywords&pageSize=10 — use the \`search\` query param, NOT \`filter\` (filter returns unrelated icons). Icon keys use snake_case and typically end in _negative / _outline / _positive. ⚠ DHIS2 search is **prefix-on-keyword**: \`search=pregnant\` works, \`search=pregnancy\` returns 0 (the trailing 'y' breaks the prefix). Always use a SHORT root prefix (e.g. \`preg\`, \`vacc\`, \`mater\`) when discovering, then use the exact \`key\` from the response.
- PATCH: the tool sends Content-Type application/json-patch+json automatically. Pass either a JSON Patch array \`[{op:"add"|"replace",path:"/style",value:{...}}]\` or a plain object (auto-wrapped into top-level add ops). For icon/color on any metadata object, prefer manage_metadata(action=update_style).
- Single object: {type}/{id}?fields=:all
For counting only: add totalPages=true&pageSize=1 and read pager.total from result.
For tracker filters: use filter={attributeId}:eq:{value} NOT dimension syntax.
For analytics dimension filters: use dimension={stageId}.{dataElementId}:{optionCode}
Always use option CODE (not displayName) in filters.
⚠️ NEVER use PUT/PATCH/POST on sharing endpoints (e.g. {type}/{id}/sharing or sharing?type=...) — these will fail with 405/500. Use manage_metadata(action=update_sharing) instead.`,
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'API path after /api/{version}/. See description for exact syntax.'
          },
          method: {
            type: 'string',
            enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
            description: 'HTTP method. Default: GET.'
          },
          body: {
            type: 'object',
            description: 'JSON body for POST/PUT/PATCH requests.'
          },
          query_params: {
            type: 'object',
            description: 'Optional query params to append safely (URL-encoded). Use this instead of manually concatenating complex query strings.'
          },
          confirm_bulk_delete: {
            type: 'boolean',
            description: 'Required to authorize POST metadata?importStrategy=DELETE on more than one object. Only set true after listing the exact IDs to the user and getting an explicit "yes".'
          },
          acknowledge_large_bulk: {
            type: 'boolean',
            description: `Second-level acknowledgement for bulk deletes larger than ${BULK_DELETE_SOFT_CAP} objects. Required IN ADDITION TO confirm_bulk_delete. Reduces blast radius when audit-style sweeps misfire.`
          },
          skip_backup: {
            type: 'boolean',
            description: 'DANGEROUS. Bypass the auto-backup that runs before any item-level write (PUT / PATCH / DELETE on metadata) or bulk delete. Only set true after the user has been told the backup step failed AND has explicitly authorized proceeding without recovery.'
          }
        },
        required: ['path']
      }
    }
  },

  {
    type: 'function',
    function: {
      name: 'count_records',
      description: `Count tracker records (enrollments, events, or tracked entities) for the CURRENT program and org unit.
This is the FASTEST tool for "how many" questions. Uses analytics for accurate org-unit-scoped counts.
Use this instead of dhis2_query tracker lists for pure count questions.
Default scope is the selected facility OU (leaf/last OU layer) unless user explicitly asks for descendants/all facilities.
Examples:
- "How many enrolled?" → record_type=enrollments
- "How many events in Antenatal stage?" → record_type=events, stage_id=WZbXY0S00lP
- "How many females enrolled?" → record_type=tracked_entities, filters=["cejWyOfXge6:eq:Female"]
- "How many events from 2023-2025?" → record_type=events, date_after=2023-01-01, date_before=2025-12-31
- "How many patients/people enrolled?" → record_type=enrollments (counts enrollments at the specific org unit)`,
      parameters: {
        type: 'object',
        properties: {
          record_type: {
            type: 'string',
            enum: ['enrollments', 'events', 'tracked_entities'],
            description: 'What to count.'
          },
          stage_id: {
            type: 'string',
            description: 'Program stage ID. Only for events record_type.'
          },
          include_children: {
            type: 'boolean',
            description: 'Include child org units (DESCENDANTS). Default: false (SELECTED org unit only).'
          },
          filters: {
            type: 'array',
            items: { type: 'string' },
            description: 'Filter strings. Format: {attributeId}:eq:{value} or {attributeId}:like:{value}. Use attribute/data element IDs from the metadata.'
          },
          date_after: {
            type: 'string',
            description: 'Only records after this date (YYYY-MM-DD).'
          },
          date_before: {
            type: 'string',
            description: 'Only records before this date (YYYY-MM-DD).'
          },
          status: {
            type: 'string',
            description: 'Filter by status (ACTIVE, COMPLETED, CANCELLED for enrollments; ACTIVE, COMPLETED, SCHEDULE for events).'
          },
          program_override: {
            type: 'string',
            description: 'Override program ID. Only if user asks about a DIFFERENT program.'
          },
          ou_override: {
            type: 'string',
            description: 'Override org unit ID. Only if user asks about a DIFFERENT org unit.'
          }
        },
        required: ['record_type']
      }
    }
  },

  {
    type: 'function',
    function: {
      name: 'get_event_analytics',
      description: `Get aggregated event/tracker data. Best for trends, breakdowns, and cross-tabulations.
Uses the analytics/events/aggregate or analytics/events/query endpoint.
IMPORTANT: This works on the CURRENT program. It can aggregate by:
- Period (monthly, quarterly, yearly trends)
- Data element values (breakdown by category)
- Organisation unit
Examples:
- "Monthly trend of events in Booking stage" → aggregate_type=aggregate, stage_id=WZbXY0S00lP, period=LAST_12_MONTHS
- "Count by blood type in Lab stage" → aggregate_type=aggregate, stage_id=BjNpOxjvEj5, breakdown_dimension={stageId}.{bloodTypeDeId}
- "List events with details" → aggregate_type=query, stage_id=..., value_dimensions=["{stageId}.{deId1}","{stageId}.{deId2}"]`,
      parameters: {
        type: 'object',
        properties: {
          aggregate_type: {
            type: 'string',
            enum: ['aggregate', 'query'],
            description: '"aggregate" for counts/sums, "query" for tabular event data.'
          },
          stage_id: {
            type: 'string',
            description: 'Program stage ID to focus on. Optional for aggregate.'
          },
          period: {
            type: 'string',
            description: 'Period dimension: LAST_12_MONTHS, LAST_4_QUARTERS, 2024, 202401;202402, THIS_YEAR, LAST_5_YEARS, etc.'
          },
          breakdown_dimension: {
            type: 'string',
            description: 'Dimension to break down by. Format: {stageId}.{dataElementId} for data element breakdown, or {stageId}.{dataElementId}:{optionCode} to filter by specific value.'
          },
          value_dimensions: {
            type: 'array',
            items: { type: 'string' },
            description: 'For query type: list of dimensions to include as columns. Format: {stageId}.{dataElementId}'
          },
          date_range: {
            type: 'object',
            properties: {
              start: { type: 'string', description: 'Start date YYYY-MM-DD' },
              end: { type: 'string', description: 'End date YYYY-MM-DD' }
            }
          },
          ou_override: {
            type: 'string',
            description: 'Override org unit. Use {ouId};CHILDREN for children, LEVEL-{n} for a level.'
          },
          ou_mode: {
            type: 'string',
            enum: ['SELECTED', 'DESCENDANTS'],
            description: 'Org unit mode for analytics. DESCENDANTS expands to child org units.'
          },
          page_size: {
            type: 'number',
            description: 'For query type: number of rows. Default: 100.'
          },
          event_filters: {
            type: 'array',
            description: 'For query type: event filters. Each filter becomes filter={dimension}:{operator}:{value}.',
            items: {
              type: 'object',
              properties: {
                dimension: { type: 'string', description: 'Data element dimension, usually {stageId}.{dataElementId}.' },
                operator: { type: 'string', enum: ['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'like', 'ilike'] },
                value: { type: 'string', description: 'Filter value (option CODE for option sets).' }
              },
              required: ['dimension', 'operator', 'value']
            }
          }
        },
        required: ['aggregate_type']
      }
    }
  },

  {
    type: 'function',
    function: {
      name: 'get_program_info',
      description: `Get information about a program's structure, rules, indicators, stages, or data elements.
Defaults to the CURRENT program in context — but pass program_id (or program_name) to inspect ANY program, e.g. when you are on the Dashboard / Data Visualizer app (no program in context) and need a program's stages or tracked-entity attributes to build a program indicator. Use when you need detail beyond what is already in context, like:
- Full list of program rules with conditions and actions
- Complete option set details
- Program indicators with expressions
- Stage sections layout / stage data elements & attributes (to reference in a PI expression)`,
      parameters: {
        type: 'object',
        properties: {
          info_type: {
            type: 'string',
            enum: ['rules', 'rules_for_stage', 'indicators', 'stage_details', 'option_set'],
            description: 'What to fetch. rules=all program rules, rules_for_stage=rules targeting a specific stage, indicators=program indicators with expressions, stage_details=all stages summary (no target_id) or full stage detail with data elements (with target_id), option_set=options for a specific option set.'
          },
          program_id: {
            type: 'string',
            description: 'Target program UID. Overrides the page-context program. Use this when the program you need is NOT the one open on the page (e.g. building a dashboard chart). Reuse a UID from a prior tool result — never invent one.'
          },
          program_name: {
            type: 'string',
            description: 'Target program display name, resolved to a UID server-side. Use when you know the name but not the UID and no program is in context. program_id takes precedence if both are given.'
          },
          target_id: {
            type: 'string',
            description: 'Stage ID (for rules_for_stage/stage_details) or option set ID (for option_set).'
          },
          include_actions: {
            type: 'boolean',
            description: 'For rules: include programRuleActions. Default: false (faster).'
          }
        },
        required: ['info_type']
      }
    }
  },

  {
    type: 'function',
    function: {
      name: 'get_program_recent_changes',
      description: `Get recent metadata changes for a DHIS2 program.
Use this when the user asks:
- what changed in a program
- recent changes / modifications / history
- changes in the last week / month / N days

Behavior:
- resolves a program by current context, program_id, or program_name
- tries metadata audit support if the instance exposes it
- otherwise falls back to current metadata objects whose created/lastUpdated timestamps fall in the requested window
- returns structured changes with stage, data element, actor, timestamp, and current metadata details

Important limitation:
- if the instance does NOT expose metadata audit logs, this tool returns recent modifications derived from metadata timestamps, not field-level before/after diffs.`,
      parameters: {
        type: 'object',
        properties: {
          program_id: {
            type: 'string',
            description: 'Target program ID. If omitted, use current context or resolve from program_name.'
          },
          program_name: {
            type: 'string',
            description: 'Target program display name when not using the current program context.'
          },
          days_back: {
            type: 'integer',
            description: 'Relative window in days. Default: 30.'
          },
          updated_after: {
            type: 'string',
            description: 'Absolute start date in YYYY-MM-DD. Overrides days_back.'
          },
          updated_before: {
            type: 'string',
            description: 'Absolute end date in YYYY-MM-DD. Default: today.'
          },
          limit: {
            type: 'integer',
            description: 'Maximum number of individual changes to return. Default: 100.'
          },
          require_real_logs: {
            type: 'boolean',
            description: 'If true, fail unless the instance exposes true metadata audit/changelog logs for add/update history. Use this for explicit "metadata logs" or "audit logs" questions.'
          }
        }
      }
    }
  },

  {
    type: 'function',
    function: {
      name: 'search_metadata',
      description: `Search for DHIS2 metadata objects by name or list objects of a type.
Use when looking up IDs, searching for org units, data elements, programs, etc.
For cross-program comparisons such as "which program has the most program indicators/rules/stages", use object_type="programs" — the default program fields include per-program size counts so one call is enough.`,
      parameters: {
        type: 'object',
        properties: {
          object_type: {
            type: 'string',
            description: 'Metadata type: programs, dataElements, indicators, organisationUnits, optionSets, dataSets, users, userGroups, programIndicators, validationRules, categoryOptionCombos, etc.'
          },
          name_filter: {
            type: 'string',
            description: 'Search by name (case-insensitive partial match).'
          },
          id: {
            type: 'string',
            description: 'Get a specific object by ID.'
          },
          filters: {
            type: 'array',
            items: { type: 'string' },
            description: 'Additional filters in DHIS2 format. Example: ["level:eq:3", "parent.id:eq:abc123"]'
          },
          fields: {
            type: 'string',
            description: 'Custom field selection. Default varies by type.'
          },
          page_size: {
            type: 'number',
            description: 'Max results. Default: 50.'
          }
        },
        required: ['object_type']
      }
    }
  },

  {
    type: 'function',
    function: {
      name: 'resolve_option_codes',
      description: `Resolve DHIS2 option codes to human-readable display names, and/or data element IDs to display names.
Use this when API responses contain raw codes or IDs that need to be shown to the user.
Examples:
- Drug codes like "M-360-8010" → "betaine 1gm/teaspoon powder"
- Data element IDs like "abc123" → "Blood Pressure Systolic"
- Org unit IDs → display names
Call this BEFORE presenting data to the user if any values look like codes/IDs.`,
      parameters: {
        type: 'object',
        properties: {
          option_codes: {
            type: 'array',
            items: { type: 'string' },
            description: 'Option codes to resolve to display names.'
          },
          data_element_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Data element IDs to resolve to display names.'
          },
          org_unit_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Organisation unit IDs to resolve to display names.'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'detect_enrollment_abnormalities',
      description: `Detect abnormal enrollments in the CURRENT tracker program and org unit.
Use for questions like "which enrollments need attention?" or "how many people have abnormalities?".
Fast + reliable behavior:
- Uses enrollment analytics for total baseline count
- Scans recent enrollments in pages and flags abnormal patterns
- Returns both summary counts and sample abnormal enrollments`,
      parameters: {
        type: 'object',
        properties: {
          include_children: {
            type: 'boolean',
            description: 'Include child org units. Default: false.'
          },
          status: {
            type: 'string',
            description: 'Enrollment status filter: ACTIVE, COMPLETED, CANCELLED.'
          },
          date_after: {
            type: 'string',
            description: 'Only enrollments after this date (YYYY-MM-DD).'
          },
          date_before: {
            type: 'string',
            description: 'Only enrollments before this date (YYYY-MM-DD).'
          },
          scan_page_size: {
            type: 'number',
            description: 'Page size for scan. Default 200, max 500.'
          },
          max_pages: {
            type: 'number',
            description: 'Max pages to scan for speed. Default 6, max 12.'
          },
          sample_size: {
            type: 'number',
            description: 'Max abnormal enrollments to return in detail. Default 50, max 100.'
          },
          program_override: {
            type: 'string',
            description: 'Override program ID only when user explicitly asks for another program.'
          },
          ou_override: {
            type: 'string',
            description: 'Override org unit ID only when user explicitly asks for another org unit.'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'cross_stage_entity_intersection',
      description: `Count tracked entities matching multiple conditions across stages (reliable person-level AND/OR logic).
Use this for questions like "how many women had abortion AND chronic hypertension?".
This avoids incorrect zeroes from stage mismatch or invalid analytics combinations.
The tool auto-expands condition lookup across relevant stages/data elements when needed (metadata-driven, not hardcoded).`,
      parameters: {
        type: 'object',
        properties: {
          all_of: {
            type: 'array',
            description: 'Conditions that ALL must be true.',
            items: {
              type: 'object',
              properties: {
                stage_id: { type: 'string' },
                data_element_id: { type: 'string' },
                operator: { type: 'string', enum: ['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'like', 'ilike'] },
                value: { type: 'string' },
                label: { type: 'string', description: 'Human condition text, e.g. "Chronic hypertension". If stage/data_element are missing, tool resolves candidates from metadata.' }
              }
            }
          },
          any_of: {
            type: 'array',
            description: 'At least one of these must be true (OR group).',
            items: {
              type: 'object',
              properties: {
                stage_id: { type: 'string' },
                data_element_id: { type: 'string' },
                operator: { type: 'string', enum: ['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'like', 'ilike'] },
                value: { type: 'string' },
                label: { type: 'string', description: 'Human condition text, e.g. "Chronic hypertension". If stage/data_element are missing, tool resolves candidates from metadata.' }
              }
            }
          },
          include_children: {
            type: 'boolean',
            description: 'Include child org units (DESCENDANTS). Default: true.'
          },
          page_size: {
            type: 'number',
            description: 'Tracker events page size. Default: 1000.'
          },
          max_pages: {
            type: 'number',
            description: 'Max pages per condition for safety. Default: 20.'
          },
          program_override: {
            type: 'string',
            description: 'Optional program override.'
          },
          ou_override: {
            type: 'string',
            description: 'Optional org unit override.'
          }
        }
      }
    }
  },

  {
    type: 'function',
    function: {
      name: 'line_listing_guide',
      description: `Get Line Listing app guidance blocks (B00-B13) using keyword routing.
Use this FIRST for "how to use Line Listing UI" questions, troubleshooting, or screenshots in Line Listing app.
Returns only the relevant blocks for speed and reliability.`,
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'User question or task in Line Listing.'
          },
          is_screenshot: {
            type: 'boolean',
            description: 'Set true when user attached screenshot.'
          },
          force_blocks: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional explicit block IDs, e.g., ["B02","B03"].'
          }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_visualization_details',
      description: `Load and explain a DHIS2 Data Visualizer visualization (chart, table, pivot, map) from its ID.
Primary endpoint: visualizations/{id}.json?fields=:all
Use this whenever user asks about a chart/table in Data Visualizer (URL like apps/data-visualizer#/XGcG2PFIvOU).
This tool automatically resolves ALL names — indicators, data elements, org units, periods — so you get human-readable metadata, never raw IDs.
Returns:
- human_summary: A pre-built explanation you can use directly in your response
- visualization: name, chart type (type_friendly), description, owner
- layout.data_items: enriched data items with displayName, description, numerator/denominator descriptions, indicator type
- scope.periods: resolved period tokens with plain-language summary
- scope.org_units: resolved org unit names with plain-language summary
- layout.layout_summary: what columns/rows/filters represent
- chart_settings: aggregation, stacking, cumulative, regression, sorting
- analytics_preview: actual data values (with _resolved_table for name-resolved rows)
- values_status: whether actual values are available or why not
- api_endpoints: definition, render, and analytics blueprint endpoints
For best answers:
1) Use human_summary as your foundation
2) Expand with data_items descriptions and numerator/denominator details
3) For value questions, use analytics_preview._resolved_table (names already resolved)
4) If values unavailable (analytics_tables_missing), you MUST still fully explain the visualization using the metadata (name, type, data items, periods, org units, layout). Mention the data limitation briefly at the end — NEVER make it the main response
5) For technical questions, include exact API paths from api_endpoints`,
      parameters: {
        type: 'object',
        properties: {
          visualization_id: {
            type: 'string',
            description: 'Visualization ID (UID). Optional if current URL is apps/data-visualizer#/ID.'
          },
          include_full_definition: {
            type: 'boolean',
            description: 'Include full visualizations/{id}.json?fields=:all payload. Default: true.'
          },
          include_analytics_preview: {
            type: 'boolean',
            description: 'Attempt an analytics preview using generated query blueprint. Default: true.'
          },
          analytics_preview_limit: {
            type: 'number',
            description: 'Max rows for analytics preview. Default 50, max 200.'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_map_details',
      description: `Load and explain a DHIS2 Maps application map from its ID.
Primary endpoint: maps/{id}.json?fields=:all
Use this whenever user asks about a map in the Maps app (URL like apps/maps#/voX07ulo2Bq).
This tool automatically resolves ALL names — indicators, data elements, org units, periods, programs, legend sets — so you get human-readable metadata, never raw IDs.
A DHIS2 map contains one or more layers (mapViews). Layer types include:
- thematic (thematic1/thematic2): Choropleth or bubble maps showing indicator/data element values by geography
- event: Individual tracker/event data points on the map
- facility: Organisation unit locations colored by group set
- boundary: Organisation unit boundary polygons
- earthEngine: Google Earth Engine satellite/raster data
- external: External tile layers (custom basemaps)
Returns:
- human_summary: A pre-built explanation you can use directly in your response
- map: name, basemap, center coordinates, zoom level, owner
- layers[]: array of parsed layers, each with type, data items, org units, periods, styling, and resolved names
- api_endpoints: definition endpoint and per-layer analytics endpoints
For best answers:
1) Use human_summary as your foundation
2) Describe each layer: what data it shows, geographic scope, time period, and styling
3) For thematic layers, explain the indicator/data element with descriptions and numerator/denominator
4) For event layers, mention the program/stage and any style data items
5) For multi-layer maps, explain how the layers relate to each other
6) If analytics data is available, include key values from the preview`,
      parameters: {
        type: 'object',
        properties: {
          map_id: {
            type: 'string',
            description: 'Map ID (UID). Optional if current URL is apps/maps#/ID.'
          },
          include_full_definition: {
            type: 'boolean',
            description: 'Include full maps/{id}.json?fields=:all payload. Default: true.'
          },
          include_analytics_preview: {
            type: 'boolean',
            description: 'Attempt analytics preview for thematic layers. Default: true.'
          },
          analytics_preview_limit: {
            type: 'number',
            description: 'Max rows for analytics preview per layer. Default 50, max 200.'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browse_web',
      description: `Browse the web using Tavily search for up-to-date external information.
Use this when user explicitly asks to browse/search web, asks for latest/current news, or asks questions requiring non-DHIS2 internet sources.
Return concise evidence with source URLs and snippets. Prefer high-quality sources.
If user enabled web browsing from UI, this tool should usually be called before final answer.`,
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query in natural language.'
          },
          search_depth: {
            type: 'string',
            enum: ['basic', 'advanced'],
            description: 'Search depth. advanced is broader/deeper.'
          },
          max_results: {
            type: 'number',
            description: 'Max results to return (1-10). Default 5.'
          },
          include_answer: {
            type: 'boolean',
            description: 'Ask Tavily for a concise synthesized answer. Default true.'
          },
          include_raw_content: {
            type: 'boolean',
            description: 'Include long extracted text from pages. Default false.'
          },
          include_domains: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional allowlist domains.'
          },
          exclude_domains: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional blocklist domains.'
          }
        },
        required: ['query']
      }
    }
  },

  {
    type: 'function',
    function: {
      name: 'render_chart',
      description: 'Render a chart (bar, line, pie, area, gauge, heatmap, etc.). CRITICAL: When the user asks to "create a chart", "make a chart", "visualize", or "graph", you MUST call this tool with chart_type, title, x_axis.categories, and series[].data. Use actual data from previous tool calls. Do NOT describe the chart — call this tool to render it.',
      parameters: {
        type: 'object',
        properties: {
          chart_type: {
            type: 'string',
            enum: ['line','bar','horizontal_bar','pie','stacked_bar','area','scatter','gauge','heatmap'],
          },
          title: { type: 'string' },
          subtitle: { type: 'string' },
          x_axis: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              categories: { type: 'array', items: { type: 'string' } }
            }
          },
          y_axis: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              min: { type: 'number' },
              max: { type: 'number' },
              format: { type: 'string', enum: ['number','percent','thousands'] }
            }
          },
          series: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                data: { type: 'array', items: { type: 'number' }, description: 'Array of numeric data values. Use null for missing points.' },
                type_override: { type: 'string' },
                color: { type: 'string' },
                stack_group: { type: 'string' }
              },
              required: ['name','data']
            }
          },
          annotations: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['threshold_line','target_line','average_line'] },
                value: { type: 'number' },
                label: { type: 'string' },
                color: { type: 'string' },
                line_style: { type: 'string', enum: ['solid','dashed'] }
              }
            }
          },
          data_table: { type: 'boolean' },
          source_info: { type: 'string' }
        },
        required: ['chart_type','title','series']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_metadata',
      description: 'Create DHIS2 metadata: programs (with stages, data elements, option sets, program rules), standalone option sets, standalone data elements, or add data elements to an existing program stage. Handles full dependency chain and atomic import.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['create_program', 'add_stage', 'add_data_elements_to_stage', 'add_program_rules', 'create_option_set', 'create_data_elements', 'create_category_combo'],
            description: 'Which creation operation to perform. Use add_data_elements_to_stage to add existing or new data elements to an existing program stage. Use create_category_combo for disaggregation/attribute combos (HTS-by-Sex, OPV-by-Dose, etc.) — bundles options + categories + combo in one atomic POST and triggers CoC regeneration. Use create_data_elements with domain_type=AGGREGATE + category_combo (or category_combo_id / category_combo_name) for aggregate-dataset DEs that need disaggregation.'
          },
          program_name: { type: 'string', description: 'Program display name (for create_program)' },
          program_short_name: { type: 'string', description: 'Short name (max 50 chars, auto-derived if omitted)' },
          program_description: { type: 'string', description: 'Program description shown in Maintenance/Capture (for create_program).' },
          program_color: { type: 'string', description: 'Program style color hex, e.g. "#E91E63" (for create_program).' },
          program_icon: { type: 'string', description: 'Program style icon key — MUST be a real DHIS2 icon key; verify with manage_metadata(action=discover_icons, search="…") first (for create_program).' },
          program_type: {
            type: 'string',
            enum: ['WITH_REGISTRATION', 'WITHOUT_REGISTRATION'],
            description: 'WITH_REGISTRATION = Tracker, WITHOUT_REGISTRATION = Event'
          },
          tracked_entity_type_id: { type: 'string', description: 'For WITH_REGISTRATION (tracker) programs: the TrackedEntityType to use. If the user NAMES a type (e.g. "Pregnant Woman", "Household"), pass that EXACT name string — an existing one is reused, a missing one is CREATED for you; NEVER substitute "Person" for a type the user named, and NEVER invent/guess a UID. Prefer a real UID only when you actually have one. If (and only if) the user did not request a specific type, omit this — it auto-resolves to the TrackedEntityType named "Person".' },
          program_attributes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Existing trackedEntityAttribute UID to REUSE as-is (from search_metadata or an "already exists on object <UID>" server error). When set, NO new TEA is created and value_type is ignored.' },
                name: { type: 'string', description: 'Attribute display name. If a TEA with this EXACT name already exists on the server it is automatically REUSED (never duplicated); otherwise a new one is created.' },
                short_name: { type: 'string' },
                value_type: { type: 'string', description: 'e.g. TEXT, DATE, BOOLEAN, NUMBER, PHONE_NUMBER, EMAIL. Required only when a NEW attribute must be created.' },
                option_set: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    options: { type: 'array', items: { type: 'string' } }
                  },
                  description: 'Inline option set for this attribute'
                },
                mandatory: { type: 'boolean' },
                searchable: { type: 'boolean' },
                display_in_list: { type: 'boolean' },
                description: { type: 'string', description: 'Attribute description (shown in Maintenance).' },
                unique: { type: 'boolean', description: 'Value must be unique across the instance (IDs, registration numbers).' },
                generated: { type: 'boolean', description: 'Auto-generated identifier (implies unique). Capture generates the value from the TextPattern.' },
                pattern: { type: 'string', description: 'TextPattern for generated attributes, e.g. "RANDOM(########)" or \'"PW-"+SEQUENTIAL(######)\'. Default RANDOM(########).' }
              },
              required: ['name']
            },
            description: 'Tracked entity attributes for the program (for create_program with tracker programs). Common attributes (First/Full name, Date of birth/DoB, Sex, National ID, phone …) usually ALREADY EXIST on the instance — NEVER try to recreate them: list them by their exact existing name (or pass id) and the tool reuses the existing TEA; only genuinely new names are created.'
          },
          org_unit_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'OU IDs the program is assigned to (separate from sharing). Defaults to current context OU.'
          },
          assign_all_org_units: {
            type: 'boolean',
            description: 'Auto-assign every OU server-side. Use for "all OUs/levels/facilities" phrasing; overrides org_unit_ids.'
          },
          sharing: {
            type: 'object',
            properties: {
              public_access: { type: 'string', description: '8-char access string. Default "rwrw----".' },
              include_current_user: { type: 'boolean', description: 'Add the current user with full access.' },
              user_ids: { type: 'array', items: { type: 'string' } },
              user_group_ids: { type: 'array', items: { type: 'string' } },
              apply_to_children: { type: 'boolean', description: 'Cascade to stages/DEs/option sets. Default true.' }
            },
            description: 'Sharing for the new program; cascades to children unless apply_to_children=false.'
          },
          stages: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                repeatable: { type: 'boolean' },
                data_elements: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      short_name: { type: 'string' },
                      value_type: { type: 'string', description: 'e.g. TEXT, NUMBER, DATE, BOOLEAN, TRUE_ONLY, LONG_TEXT, INTEGER, INTEGER_POSITIVE, PERCENTAGE, PHONE_NUMBER, EMAIL' },
                      compulsory: { type: 'boolean' },
                      option_set: {
                        type: 'object',
                        properties: {
                          name: { type: 'string' },
                          options: { type: 'array', items: { type: 'string' } }
                        },
                        description: 'Inline option set creation: name + list of option display names'
                      }
                    },
                    required: ['name', 'value_type']
                  }
                },
                sections: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      data_elements: { type: 'array', items: { type: 'string' }, description: "Names of this stage's data elements to place in this section (must match names in data_elements above)." }
                    },
                    required: ['name', 'data_elements']
                  },
                  description: 'Optional visual sections that group the stage\'s data elements (e.g. "Signs and Risk Screening", "Laboratory Investigation"). Each section lists a subset of THIS stage\'s data element NAMES; the tool builds programStageSections so the stage renders as sections in Capture.'
                }
              },
              required: ['name', 'data_elements']
            },
            description: 'Stages with data elements and optional visual sections (for create_program)'
          },
          program_rules: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                description: { type: 'string' },
                condition: { type: 'string', description: 'Rule condition using #{variable_name} syntax' },
                actions: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      type: { type: 'string', description: 'e.g. SHOWWARNING, SHOWERROR, WARNINGONCOMPLETE, ERRORONCOMPLETE, HIDEFIELD, HIDEPROGRAMSTAGE, HIDESECTION, HIDEALLFIELDS, ASSIGN, SETMANDATORYFIELD, HIDEOPTION, DISPLAYTEXT (static banner), DISPLAYKEYVALUEPAIR (live label+value in the Feedback widget: content=label, data=expression). HIDEOPTION hides ONE option of an option-set field — pass data_element_name + option_name (never leave the option unbound). There is NO complete/close-enrollment action; a completion request becomes a SHOWWARNING prompt. HIDEALLFIELDS is sugar: pass exclude_data_element_ids:[<trigger DE>] and the tool auto-expands into HIDEFIELDs (trigger stage) + HIDEPROGRAMSTAGEs (other stages). NO SHOW action exists: "show X when C" = ONE HIDEFIELD rule with the NEGATED condition (fields re-appear automatically) — show/hide pairs and HIDEFIELD+SETMANDATORYFIELD on the same field are refused.' },
                      data_element_name: { type: 'string', description: 'Target DE name (resolved to ID automatically)' },
                      tracked_entity_attribute_name: { type: 'string', description: 'Target TEA name for HIDEFIELD on a tracked entity attribute (resolved to ID automatically)' },
                      program_stage_name: { type: 'string', description: 'Target stage NAME (for HIDEPROGRAMSTAGE/CREATEEVENT). In create_program ALWAYS use this — stage IDs are generated during the call and cannot be known in advance; the tool resolves the name to the new stage UID.' },
                      program_stage_id: { type: 'string', description: 'Target stage ID (for HIDEPROGRAMSTAGE on an EXISTING program, e.g. add_program_rules). During create_program use program_stage_name instead.' },
                      content: { type: 'string', description: 'Static message text for SHOWWARNING/SHOWERROR/WARNINGONCOMPLETE/ERRORONCOMPLETE/DISPLAYTEXT. Variables in content are shown literally — use the data field for dynamic refs.' },
                      data: { type: 'string', description: 'd2 expression evaluated at runtime. ASSIGN: target value. SHOWWARNING/SHOWERROR/etc: dynamic content appended after the static content prefix (e.g. data="#{my_de}" or data="d2:concatenate(\\"X=\\", #{a})").' },
                      location: { type: 'string', description: 'For DISPLAYTEXT/DISPLAYKEYVALUEPAIR: which widget shows it — "feedback" (default) or "indicators". DISPLAYKEYVALUEPAIR shows content as the key and the evaluated data expression as the value — the right choice for "display X in the Feedback widget".' },
                      exclude_data_element_ids: { type: 'array', items: { type: 'string' }, description: 'For HIDEALLFIELDS: DE ids to keep visible (typically the trigger DE).' },
                      option_name: { type: 'string', description: "For HIDEOPTION: exact display name of the option to hide (an option of data_element_name's option set created in THIS call)." },
                      option_code: { type: 'string', description: 'For HIDEOPTION: the option CODE to hide (alternative to option_name).' }
                    },
                    required: ['type']
                  }
                }
              },
              required: ['name', 'condition', 'actions']
            },
            description: 'Program rules (for create_program or add_program_rules)'
          },
          program_indicators: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                short_name: { type: 'string' },
                analytics_type: { type: 'string', description: 'EVENT or ENROLLMENT (default: EVENT)' },
                aggregation_type: { type: 'string', description: 'COUNT, SUM, AVERAGE, etc. (default: COUNT)' },
                expression: { type: 'string', description: 'e.g. V{event_count}' },
                filter: { type: 'string', description: 'e.g. #{stageId.deId} == \'value\'' },
                description: { type: 'string' }
              },
              required: ['name', 'expression']
            },
            description: 'Program indicators (for create_program). Created as a follow-up POST after main program creation.'
          },
          program_id: { type: 'string', description: 'Existing program ID (for add_stage / add_program_rules)' },
          stage: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              repeatable: { type: 'boolean' },
              data_elements: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    short_name: { type: 'string' },
                    value_type: { type: 'string' },
                    compulsory: { type: 'boolean' },
                    option_set: {
                      type: 'object',
                      properties: {
                        name: { type: 'string' },
                        options: { type: 'array', items: { type: 'string' } }
                      }
                    }
                  },
                  required: ['name', 'value_type']
                }
              },
              sections: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    data_elements: { type: 'array', items: { type: 'string' }, description: "Names of this stage's data elements to place in this section." }
                  },
                  required: ['name', 'data_elements']
                },
                description: 'Optional visual sections grouping this stage\'s data elements (same shape as create_program stages[].sections).'
              }
            },
            description: 'Single stage object (for add_stage). Existing data elements and option sets are REUSED by exact name — safe to repeat DEs already used in earlier stages (blood pressure, referral fields, …).'
          },
          data_elements: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                short_name: { type: 'string' },
                code: { type: 'string', description: 'Optional unique code (slug-style: A-Z, 0-9, _).' },
                description: { type: 'string' },
                value_type: { type: 'string', description: 'INTEGER / NUMBER / TEXT / BOOLEAN / DATE / etc.' },
                domain_type: { type: 'string', enum: ['TRACKER', 'AGGREGATE'], description: 'AGGREGATE = used in dataSets (aggregate "programs"). TRACKER = used in event/tracker programs. Defaults to TRACKER, or to the batch-level domain_type if set on the call.' },
                aggregation_type: { type: 'string', description: 'SUM / AVERAGE / COUNT / NONE / etc. Defaults to SUM for AGGREGATE, NONE for TRACKER.' },
                category_combo_id: { type: 'string', description: 'Per-DE override: bind THIS DE to a specific categoryCombo UID (skips inline/batch combo).' },
                use_category_combo: { type: 'boolean', description: 'When the call also passes an inline category_combo (or category_combo_id), set true on each DE that needs disaggregation. DEs without this flag stay on the system default combo (no disaggregation).' },
                use_default_combo: { type: 'boolean', description: 'Force this DE onto the system default categoryCombo (no disaggregation), even when the batch has an inline combo. Use for "no disaggregation" rows in a mixed dataset.' },
                option_set: {
                  type: 'object',
                  description: 'Inline option set to CREATE and attach to this DE. Use ONLY when the option set does not exist yet. To attach an EXISTING option set (e.g. one just created via manage_option_sets), use option_set_id instead — do NOT re-inline it (that makes a duplicate set).',
                  properties: {
                    name: { type: 'string' },
                    options: { type: 'array', items: { type: 'string' } }
                  }
                },
                option_set_id: { type: 'string', description: 'Attach an EXISTING option set to this DE by UID. Chain the option_set_id returned by manage_option_sets(action="create"). The DE valueType is auto-aligned to the referenced set (TEXT/MULTI_TEXT). Mutually exclusive with the inline option_set.' },
                option_set_name: { type: 'string', description: 'Attach an EXISTING option set to this DE by exact name (resolved to its UID). Use option_set_id when you already have the UID. Mutually exclusive with the inline option_set.' }
              },
              required: ['name', 'value_type']
            },
            description: 'Standalone data elements (for create_data_elements). Each DE can opt into the inline category_combo via use_category_combo:true, or stay on the default combo. Attach an option set either inline (option_set — creates a new set) or by reference (option_set_id / option_set_name — reuses an existing set). Mix freely in one call.'
          },
          category_combo: {
            type: 'object',
            description: 'Inline categoryCombo definition. Use for create_category_combo (the combo itself), or for create_data_elements (auto-bundles the combo with the DEs in one atomic POST). Categories/options that already exist on the server are reused by exact-name match.',
            properties: {
              name: { type: 'string', description: 'CategoryCombo display name (e.g. "HTS Result by Sex").' },
              short_name: { type: 'string' },
              code: { type: 'string' },
              description: { type: 'string' },
              data_dimension_type: { type: 'string', enum: ['DISAGGREGATION', 'ATTRIBUTE'], description: 'DISAGGREGATION = column splits inside the form (default). ATTRIBUTE = whole-row attribute (e.g. partner organisation across the dataset).' },
              skip_total: { type: 'boolean' },
              categories: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', description: 'Reuse an existing category by UID (preferred when known).' },
                    name: { type: 'string', description: 'Category display name. If a category with this exact name already exists, it is reused; otherwise a new one is created with the supplied options[].' },
                    code: { type: 'string' },
                    short_name: { type: 'string' },
                    options: {
                      type: 'array',
                      items: { type: 'string' },
                      description: 'CategoryOption display names. Required when creating a new category. Existing options with these exact names are reused (no duplicates).'
                    }
                  }
                },
                description: 'Each entry is either { id } to reuse, or { name, options:[...] } to create. The order matters — DHIS2 generates CategoryOptionCombo rows in this order (e.g. "HIV Result, Gender" → "Positive, Male" / "Positive, Female" / …).'
              }
            },
            required: ['name', 'categories']
          },
          category_combo_id: { type: 'string', description: 'For create_data_elements: bind every DE (with use_category_combo:true or no flag) to an existing categoryCombo UID.' },
          category_combo_name: { type: 'string', description: 'For create_data_elements: same as category_combo_id but resolved by exact name lookup. Errors if no exact match exists on the server.' },
          domain_type: { type: 'string', enum: ['TRACKER', 'AGGREGATE'], description: 'For create_data_elements: batch default for every DE (each DE may override).' },
          aggregation_type: { type: 'string', description: 'For create_data_elements: batch default for every DE (each DE may override). Defaults to SUM when domain_type=AGGREGATE.' },
          option_set_name: { type: 'string', description: 'Option set name (for create_option_set)' },
          options: { type: 'array', items: { type: 'string' }, description: 'Option display names (for create_option_set)' },
          dry_run_only: { type: 'boolean', description: 'If true, validate without importing. Default: false.' },
          stage_id: { type: 'string', description: 'Existing program stage ID (for add_data_elements_to_stage). Required for that action.' },
          data_element_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'IDs of EXISTING data elements to add to the stage (for add_data_elements_to_stage). Use when the data element already exists in DHIS2.'
          },
          section_name: { type: 'string', description: 'For add_data_elements_to_stage: name of the existing section the new data element(s) should appear under. REQUIRED when the stage uses a SECTION form and has more than one section — otherwise the tool stops and lists the sections. Omit for non-sectioned (DEFAULT) stages, or when the stage has exactly one section.' },
          section_id: { type: 'string', description: 'For add_data_elements_to_stage: id of the target section (alternative to section_name). All OTHER sections are always preserved regardless.' }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'architect_metadata',
      description: `DHIS2 Meta-Architect Agent — Research, plan, and verify complex metadata structures before and after creation.
Use this tool BEFORE calling create_metadata when building complex programs, and AFTER to verify results.

Strategic Protocol:
1. RESEARCH FIRST — Use lookup_schema to understand required fields; use check_existing to avoid duplicates; use browse_dhis2_docs when unsure.
2. PLAN — Use plan action to design the full dependency chain: Option Sets → Data Elements → TEAs → Program → Stages → Assign DEs → Program Rules.
3. BUILD — Then call create_metadata with the plan (separate tool call).
4. VERIFY — After creation, use verify to confirm all objects exist and are correctly linked.

Actions:
- lookup_schema: Fetch DHIS2 API schema for any metadata type to discover required/optional fields, allowed valueTypes, etc.
- check_existing: Search for existing metadata by name/type to reuse IDs and avoid duplicates.
- verify: After create_metadata, verify that created objects exist and are correctly configured.
- browse_dhis2_docs: Search official DHIS2 documentation for guidance on metadata configuration, program rules, or API usage.
- inspect_program: Deep inspection of an existing program's full structure (stages, DEs, rules, TEAs) for modification planning.`,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['lookup_schema', 'check_existing', 'verify', 'browse_dhis2_docs', 'inspect_program'],
            description: 'Which architect action to perform.'
          },
          schema_type: {
            type: 'string',
            description: 'For lookup_schema: metadata type to inspect (e.g. "program", "dataElement", "programRule", "programRuleAction", "programStage", "trackedEntityAttribute", "optionSet", "programRuleVariable"). Maps to /api/schemas/{type}.'
          },
          object_type: {
            type: 'string',
            description: 'For check_existing: DHIS2 API plural type (e.g. "programs", "dataElements", "optionSets", "trackedEntityAttributes", "trackedEntityTypes", "categoryCombos").'
          },
          name_filter: {
            type: 'string',
            description: 'For check_existing: search by name (case-insensitive).'
          },
          verify_ids: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', description: 'API plural type (e.g. "programs", "dataElements", "programStages")' },
                id: { type: 'string', description: 'UID to verify' },
                expected_name: { type: 'string', description: 'Expected name for validation' }
              },
              required: ['type', 'id']
            },
            description: 'For verify: array of objects to verify exist after creation.'
          },
          verify_program_id: {
            type: 'string',
            description: 'For verify: optionally verify a full program structure — checks stages, DEs, rules are all linked correctly.'
          },
          docs_query: {
            type: 'string',
            description: 'For browse_dhis2_docs: search query for DHIS2 documentation (e.g. "program rule ASSIGN action syntax", "tracker program tracked entity attributes").'
          },
          program_id: {
            type: 'string',
            description: 'For inspect_program: program ID to deeply inspect.'
          }
        },
        required: ['action']
      }
    }
  },

  // ── Program Rules Manager ────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'manage_program_rules',
      description: `CRUD + audit for DHIS2 program rules, rule variables, and rule actions. Use for listing, reading, creating, updating, deleting, auditing, or bulk-fixing rules on a program. On create, the tool auto-resolves every #{name} reference in the condition/actions: if a programRuleVariable with that name already exists it is reused; otherwise the tool looks up a program data element whose sanitized displayName matches and auto-creates a PRV with the correct sourceType/valueType/optionSet — you only need to pass variables:[] when a reference points at a DE you are creating in the same request or to override the auto defaults. Rule conditions are lint-checked before POST — boolean comparisons must use unquoted \`true\`/\`false\` and the \`!d2:hasValue(x) || x != true\` pattern for empty-or-No, never \`== false\` or quoted 'Yes'/'No'. If a #{name} cannot be resolved the tool refuses the POST and returns \`unresolved[]\` + suggestions so you can correct and retry. For "find/fix broken rules" always use action=audit first, then bulk_fix_conditions — never PUT/PATCH rules through dhis2_query.`,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'get', 'create', 'update', 'delete', 'list_variables', 'audit', 'bulk_fix_conditions'],
            description: 'list=all rules for program; get=one rule details; create=new rule(s) — use rule for single or rules for batch; update=modify existing rule; delete=remove rule; list_variables=all rule variables for program; audit=scan ALL rules for program — detects broken boolean patterns, unresolved #{var}/A{attr} references, actions missing targets/content/data, orphan references to deleted DEs/TEAs/stages/sections, variables pointing at deleted objects — returns issues with fix hints. Use audit when the user asks to find broken/non-working/problematic rules. bulk_fix_conditions=apply per-rule condition fixes in one batch after audit.'
          },
          program_id: { type: 'string', description: 'Program ID (required for list, create, list_variables, audit)' },
          rule_id: { type: 'string', description: 'Existing rule ID (required for get, update, delete)' },
          fixes: {
            type: 'array',
            description: 'Per-rule condition fixes for bulk_fix_conditions. Each entry: { rule_id, condition } to set directly, or { rule_id, find, replace } for regex replace. Conditions are lint-checked before POST; rejected entries are reported.',
            items: {
              type: 'object',
              properties: {
                rule_id: { type: 'string' },
                condition: { type: 'string', description: 'New condition (optional)' },
                find: { type: 'string', description: 'Regex to find and replace' },
                replace: { type: 'string', description: 'Replacement string' }
              }
            }
          },
          rule: {
            type: 'object',
            description: 'Rule definition (required for create; optional fields for update)',
            properties: {
              name: { type: 'string', description: 'Rule name' },
              condition: { type: 'string', description: 'd2 expression. Use #{varName} for DE variables, A{attrName} for TEA attributes. Examples: numeric: "d2:hasValue(#{queue_number}) && #{queue_number} > 0". Boolean/TRUE_ONLY yes: "#{flag} == true". Boolean empty-or-no: "!d2:hasValue(#{flag}) || #{flag} != true". Option set (with use_code_for_option_set=true): "#{status} == \'APPROVED\'". Never quote true/false and never compare booleans with == false.' },
              description: { type: 'string' },
              priority: { type: 'integer', description: 'Lower number = higher priority. Optional.' },
              variables: {
                type: 'array',
                description: 'OPTIONAL. Program rule variables to create alongside this rule. Usually unnecessary — the tool auto-creates a PRV for any #{name} in the condition/actions whose sanitized name matches a program data element\'s displayName, picking DATAELEMENT_CURRENT_EVENT when the rule acts on the same stage and DATAELEMENT_NEWEST_EVENT_PROGRAM otherwise, inheriting valueType + option-set from the DE. Supply this array only to (a) override the auto-chosen source_type, (b) reference a DE whose displayName does not match your #{name} token, or (c) create a TEI_ATTRIBUTE variable with a custom name.',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', description: 'Variable name used in #{name} in conditions' },
                    source_type: { type: 'string', enum: ['TEI_ATTRIBUTE', 'DATAELEMENT_NEWEST_EVENT_PROGRAM', 'DATAELEMENT_NEWEST_EVENT_PROGRAM_STAGE', 'DATAELEMENT_CURRENT_EVENT', 'DATAELEMENT_PREVIOUS_EVENT', 'CALCULATED_VALUE'] },
                    data_element_id: { type: 'string', description: 'DE ID (for DATAELEMENT_* source types)' },
                    tei_attribute_id: { type: 'string', description: 'TEA ID (for TEI_ATTRIBUTE source type)' },
                    program_stage_id: { type: 'string', description: 'Stage ID (for DATAELEMENT_NEWEST_EVENT_PROGRAM_STAGE)' },
                    value_type: { type: 'string', description: 'TEXT, INTEGER, NUMBER, DATE, BOOLEAN, TRUE_ONLY, etc.' },
                    use_code_for_option_set: { type: 'boolean' }
                  },
                  required: ['name', 'source_type', 'value_type']
                }
              },
              actions: {
                type: 'array',
                description: 'Rule actions to execute when condition is true',
                items: {
                  type: 'object',
                  properties: {
                    type: { type: 'string', enum: ['SHOWWARNING', 'SHOWERROR', 'WARNINGONCOMPLETE', 'ERRORONCOMPLETE', 'HIDEFIELD', 'HIDEPROGRAMSTAGE', 'HIDESECTION', 'HIDEALLFIELDS', 'ASSIGN', 'SETMANDATORYFIELD', 'DISPLAYTEXT', 'SHOWOPTIONGROUP', 'HIDEOPTIONGROUP', 'CREATEEVENT', 'SENDMESSAGE'], description: 'Action type. HIDEPROGRAMSTAGE hides an entire stage tab (needs program_stage_id). HIDESECTION hides a section within a stage (needs program_stage_section_id). HIDEALLFIELDS = chatbot-internal sugar: pass exclude_data_element_ids: [<trigger DE id>] and the tool auto-expands into HIDEFIELD per DE in the trigger\'s stage + HIDEPROGRAMSTAGE for every other stage. SHOWWARNING/SHOWERROR/WARNINGONCOMPLETE/ERRORONCOMPLETE concatenate static content + evaluated data — put #{var}/A{attr} in data, not content. NO SHOW action exists: "show X when C" = ONE hide rule with the NEGATED condition (targets re-appear automatically when it turns false) — show/hide twin rules and HIDEFIELD+SETMANDATORYFIELD on the same field are refused at lint.' },
                    content: { type: 'string', description: 'Static message text shown by SHOWWARNING/SHOWERROR/WARNINGONCOMPLETE/ERRORONCOMPLETE/DISPLAYTEXT. Variables placed here are shown LITERALLY — put dynamic refs in `data` instead.' },
                    data: { type: 'string', description: 'd2 expression evaluated at runtime. ASSIGN: assigned to the target DE/TEA. SHOWWARNING/SHOWERROR/etc: appended after content (e.g. data="#{maternal_risk_factors}" or data="d2:concatenate(\\"prefix \\", #{a}, \\", \\", #{b})"). The tool auto-moves trailing #{var}/A{attr} from content into data when content has variable refs and data is empty.' },
                    exclude_data_element_ids: { type: 'array', items: { type: 'string' }, description: 'For HIDEALLFIELDS: DE ids to keep visible (typically the trigger DE referenced in the condition).' },
                    data_element_id: { type: 'string', description: 'Target data element ID for HIDEFIELD/ASSIGN/SETMANDATORYFIELD' },
                    tei_attribute_id: { type: 'string', description: 'Target TEA ID for HIDEFIELD/ASSIGN/SETMANDATORYFIELD on attributes' },
                    program_stage_id: { type: 'string', description: 'Target stage ID (for HIDEPROGRAMSTAGE and stage-scoped actions)' },
                    program_stage_name: { type: 'string', description: 'Target stage NAME (alternative to program_stage_id — resolved to the stage id automatically)' },
                    program_stage_section_id: { type: 'string', description: 'Target section ID (for HIDESECTION)' },
                    evaluation_time: { type: 'string', enum: ['ON_DATA_ENTRY', 'ON_COMPLETE', 'ALWAYS'], description: 'When action fires. Default: ON_DATA_ENTRY' }
                  },
                  required: ['type']
                }
              }
            }
          },
          rules: {
            type: 'array',
            description: 'Array of rule definitions for batch create. Each item has same shape as rule. Use this to create multiple rules in a single call (e.g. 6 HIDEPROGRAMSTAGE rules at once).',
            items: { type: 'object' }
          },
          dry_run_only: { type: 'boolean', description: 'Validate without committing. Default: false.' },
          deep: { type: 'boolean', description: 'For audit: also validate each condition through DHIS2 /programRules/condition/description. Default: true.' },
          skip_backup: { type: 'boolean', description: 'DANGEROUS. Bypass the auto-backup that runs before update / delete / bulk_fix_conditions. Only set true after the user has been told the backup step failed AND has explicitly authorized proceeding without recovery.' }
        },
        required: ['action']
      }
    }
  },

  // ── Program Indicators Manager ───────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'manage_program_indicators',
      description: `CRUD + audit + cross-program discovery + OU ranking for DHIS2 program indicators. Actions: list/get/create/update/delete/audit/bulk_fix/bulk_fix_expressions/discover/rank_ou. **create accepts a BATCH: pass indicators:[…] to build MANY in ONE call/metadata import — always do this for analytics builds (a coverage dashboard needs 10-40 PIs and one-per-call runs out of loop budget before the charts exist).** A coverage/percentage metric is normally ONE program indicator — numerator condition in the expression via d2:condition("…",100,0) with aggregation_type AVERAGE, denominator population in the filter — NOT three separate numerator/denominator/percentage objects. expressions reference #{stageId.deId}, A{attrId}, V{enrollment_count|event_count|tei_count}, d2:count/countIfValue/condition/etc. For "find/fix broken indicators" use action=audit (paginates + validates server-side via /expression/description) then bulk_fix or bulk_fix_expressions. For "complex/heavy/big/top/most program indicators" or "indicators with lots of data" ACROSS ALL programs use action=discover — NEVER guess a program ID. For "which OUs/districts/regions/facilities have the most data/events for these indicators" use action=rank_ou with indicator_ids from a prior discover result. NEVER PUT/PATCH programIndicators through dhis2_query. NEVER invent program UIDs — always reuse UIDs from prior tool results (discover/list/get/search_metadata). For metadata-count comparisons ("which program has the most indicators") use search_metadata(object_type="programs").`,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'get', 'create', 'update', 'delete', 'audit', 'bulk_fix', 'bulk_fix_expressions', 'discover', 'rank_ou'],
            description: 'list=paginated indicator list (needs program_id); get=one indicator; create=new indicator (single `indicator` OR a BATCH via `indicators:[…]` — prefer the batch for any multi-indicator build); update=modify single existing; delete=remove; audit=check ALL indicators in a program for issues (references, boundaries, V{}/d2: names, braces, optional server validation); bulk_fix=swap a wrong stage ID across many indicators; bulk_fix_expressions=apply per-indicator expression/filter replacements in one batch; discover=cross-program scan ranking indicators by complexity (#{} refs, A{} refs, d2: funcs, operators, length) and/or per-program event volume — NO program_id required, returns top_n ranked; use for "complex/heavy/biggest/top/most complicated indicators" and "indicators with lots of data" questions. rank_ou=for "which OUs/districts/regions/facilities have the most data/events for these indicators" — pass indicator_ids (from a prior discover/list) OR programs; runs analytics/events/aggregate per distinct program with ou:{root};LEVEL-{N}, sums per-OU across programs, returns top_n OUs with per-program breakdown. Do NOT hand-build analytics URLs for this.'
          },
          program_id: { type: 'string', description: 'Program ID (required for list, create, audit; ignored by discover)' },
          indicator_id: { type: 'string', description: 'Existing indicator ID (required for get, update, delete)' },
          // indicator_ids defined once below (shared by bulk_fix and rank_ou)
          replace_stage_id: { type: 'string', description: 'Wrong/invalid stage ID to replace everywhere in expressions+filters (required for bulk_fix)' },
          with_stage_id: { type: 'string', description: 'Correct stage ID to substitute (required for bulk_fix)' },
          fixes: {
            type: 'array',
            description: 'Per-indicator expression/filter fixes for bulk_fix_expressions. Each entry: { indicator_id, expression?, filter? } to set directly, or { indicator_id, find, replace, scope? } for regex replace (scope: both|expression|filter, default both).',
            items: {
              type: 'object',
              properties: {
                indicator_id: { type: 'string' },
                expression: { type: 'string', description: 'New expression (optional)' },
                filter: { type: 'string', description: 'New filter (optional)' },
                find: { type: 'string', description: 'Regex to find and replace' },
                replace: { type: 'string', description: 'Replacement string' },
                scope: { type: 'string', enum: ['both', 'expression', 'filter'], description: 'Where find/replace is applied (default: both)' }
              }
            }
          },
          validate: { type: 'boolean', description: 'For bulk_fix_expressions: server-validate each new expression/filter before committing. Default: true.' },
          deep: { type: 'boolean', description: 'For audit: also validate each expression/filter via DHIS2 /programIndicators/expression/description endpoint (authoritative check). Default: true. Pass false on very large programs (>600 indicators) to skip.' },
          page: { type: 'integer', description: 'Page number for list action (default: 1, 50 per page). Check _has_more in response for more pages.' },
          indicator: {
            type: 'object',
            description: 'ONE indicator definition (create a single indicator, or provide only the changed fields for update). For creating MANY indicators at once, use `indicators` (array) instead — it commits them all in one metadata import.',
            properties: {
              name: { type: 'string' },
              short_name: { type: 'string', description: 'Max 50 chars. Auto-derived from name if omitted.' },
              description: { type: 'string' },
              expression: { type: 'string', description: 'What to aggregate. Count of enrollments/women → "V{enrollment_count}" (ENROLLMENT) or "V{event_count}" (EVENT). Coverage/PERCENTAGE in ONE indicator → "d2:condition(\\"<numerator condition>\\", 100, 0)" with aggregation_type "AVERAGE" (mean of the 0/100 flag over the filtered population = the %). Also: "d2:sum(#{stageId.deId})", "d2:count(#{stageId.deId})".' },
              filter: { type: 'string', description: 'Condition selecting which events/enrollments count. For a percentage indicator this is the DENOMINATOR population (e.g. "#{stageId.gestAge} < 999" = women with a valid gestational age). Examples: "#{stageId.deId} == \'value\'", "d2:count(#{stageId.contactNo}) >= 4".' },
              analytics_type: { type: 'string', enum: ['EVENT', 'ENROLLMENT'], description: 'EVENT=aggregate over events, ENROLLMENT=aggregate over enrollments/TEIs. Use ENROLLMENT for "per woman / per pregnancy" counts and coverage so a pregnancy is counted once, not once per visit.' },
              aggregation_type: { type: 'string', enum: ['COUNT', 'SUM', 'AVERAGE', 'MIN', 'MAX', 'STDDEV', 'VARIANCE', 'NONE'], description: 'How to aggregate across rows. COUNT/SUM for counts; AVERAGE for a d2:condition(...,100,0) percentage indicator. Default: COUNT.' },
              decimals: { type: 'integer', description: 'Decimal places in output. Optional (e.g. 1 for a percentage).' },
              display_in_form: { type: 'boolean', description: 'Show this indicator in the right-side "Indicators" widget of Tracker Capture / Capture data entry (DHIS2 displayInForm). Set true when the user wants the indicator visible during data entry. Default false.' }
            }
          },
          indicators: {
            type: 'array',
            description: 'BATCH create: an array of indicator objects (same shape as `indicator`) committed in ONE metadata import. USE THIS whenever you need more than one program indicator — a coverage/analytics build needs many, and one-per-call exhausts the loop budget before the charts/dashboard are built. Invalid entries are skipped and returned under failed[]; valid ones are created and their UIDs returned in program_indicator_ids for chaining into visualizations/maps/dashboard data_items. shortName and name collisions (server + intra-batch) are auto-resolved. A percentage metric is normally ONE indicator (numerator condition in the expression, denominator population in the filter) — do NOT emit separate numerator + denominator + percentage objects unless a table explicitly needs those counts as columns.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                short_name: { type: 'string' },
                description: { type: 'string' },
                expression: { type: 'string' },
                filter: { type: 'string' },
                analytics_type: { type: 'string', enum: ['EVENT', 'ENROLLMENT'] },
                aggregation_type: { type: 'string', enum: ['COUNT', 'SUM', 'AVERAGE', 'MIN', 'MAX', 'STDDEV', 'VARIANCE', 'NONE'] },
                decimals: { type: 'integer' },
                display_in_form: { type: 'boolean' }
              }
            }
          },
          dry_run_only: { type: 'boolean', description: 'Validate without committing. Default: false.' },
          sort_by: { type: 'string', enum: ['complexity', 'data_volume', 'combined'], description: 'For discover: ranking axis. complexity=expression intricacy only; data_volume=event count per program only; combined=complexity×log(events+1) (default).' },
          top_n: { type: 'integer', description: 'For discover: how many top-ranked indicators to return. Default 20, max 100.' },
          period: { type: 'string', description: 'For discover: analytics period for event counts. Default LAST_5_YEARS. Examples: LAST_12_MONTHS, LAST_10_YEARS, 2024, THIS_YEAR.' },
          name_filter: { type: 'string', description: 'For discover: optional ilike filter on indicator displayName to narrow scope (e.g. "malaria").' },
          include_event_counts: { type: 'boolean', description: 'For discover: include per-program event counts via analytics (parallel). Default true. Set false to skip data-volume axis (pure complexity ranking, 0 extra RTTs).' },
          programs: { type: 'array', items: { type: 'string' }, description: 'For discover and rank_ou: explicit program ID list. In discover, optional allowlist (default all). In rank_ou, the programs whose events are aggregated per OU — required if indicator_ids is not given.' },
          indicator_ids: { type: 'array', items: { type: 'string' }, description: 'Program indicator IDs. For bulk_fix: indicators to fix. For rank_ou: their distinct programs are aggregated per OU. Always reuse IDs from a prior discover/list/search_metadata — do NOT invent.' },
          level: { type: 'integer', description: 'For rank_ou: OU hierarchy level to break down by (2=regions, 3=districts, 4=facilities on typical instances). Default 2.' },
          root_ou: { type: 'string', description: 'For rank_ou: root org unit to expand from. Default: current ctx OU, else USER_ORGUNIT. Use a real UID — never guess.' },
          skip_backup: { type: 'boolean', description: 'DANGEROUS. Bypass the auto-backup that runs before update / delete / bulk_fix / bulk_fix_expressions. Only set true after the user has been told the backup step failed AND has explicitly authorized proceeding without recovery.' }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'manage_metadata',
      description: `Manage DHIS2 metadata lifecycle: remove data elements from program stages, delete metadata objects with smart reference checking, inspect dependencies, update program organisation-unit assignment, update sharing/access, or set the display icon+color (style).
Use this tool instead of dhis2_query for metadata removal/deletion, program OU assignment, sharing updates, or icon/style changes.
Workflow for "remove DE from program + delete it":
1. manage_metadata(action=remove_from_stage, stage_id=<id>, data_element_ids=[<deId>])
2. manage_metadata(action=delete, object_type=dataElements, object_id=<deId>)
Program OU assignment (which OUs can use the program in Capture/Tracker):
- manage_metadata(action=update_program_org_units, program_id="<id>", org_unit_ids=["<ou1>","<ou2>"], merge_mode="replace")
Sharing update (e.g., program not appearing in Capture due to missing data access):
- manage_metadata(action=update_sharing, object_type="programs", object_id=<id>, public_access="rwrw----")
Icon / display style update (any metadata object: programs, programStages, dataElements, optionSets, trackedEntityAttributes, indicators, options) — TWO STEPS, NEVER SKIP STEP 1:
1. manage_metadata(action=discover_icons, keywords=["lung","respir","tb","medical"])  ← discover real keys
2. manage_metadata(action=update_style, object_type="programs", object_id=<id>, icon=<exact key from step 1>, color="#2196F3")
update_style REFUSES any icon not verified through discover_icons this turn — DHIS2 has a fixed ~900-icon library and obvious names like "tuberculosis_positive" / "diabetes_positive" do not exist.
Access string format (8 chars): positions 1-2 = metadata (rw), positions 3-4 = data (rw), positions 5-8 reserved.
  "rw------" = metadata read+write only (NO data access — won't appear in Capture/Data Entry)
  "rwrw----" = metadata + data read+write (full access)
  "r-r-----" = metadata read + data read (read-only)`,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['remove_from_stage', 'delete', 'check_references', 'update_program_org_units', 'update_sharing', 'add_program_attributes', 'update_style', 'convert_value_type', 'discover_icons'],
            description: 'remove_from_stage = remove data element(s) from a program stage. delete = delete metadata with reference checking. check_references = list dependencies. update_program_org_units = set/add/remove the organisation units assigned to a program. update_sharing = update sharing/access settings via the DHIS2 sharing API. add_program_attributes = add tracked-entity attributes (by id or name, optionally creating new ones) to an existing program, with searchable / displayInList / mandatory flags. update_style = set the display icon and/or color on any metadata object. discover_icons = REQUIRED before update_style for any icon you have not already verified this turn. Pass keywords[] (broad short roots like ["lung","respir","tb","medical","clinic"] for a TB program) and the tool returns every matching real DHIS2 icon key + its keywords in one shot. update_style refuses fabricated keys; you MUST pick from a discover_icons response. convert_value_type = change valueType of a dataElement, trackedEntityAttribute, or optionSet (and cascade — e.g. converting an optionSet to MULTI_TEXT also flips every DE/TEA referencing it). Use this for "make this multi-select" / "switch to text with multiple values" requests; it patches both ends so the DE+optionSet pair stays consistent.'
          },
          object_type: {
            type: 'string',
            enum: ['dataElements', 'optionSets', 'options', 'trackedEntityAttributes', 'programStages', 'categoryOptions', 'categories', 'categoryCombos', 'indicators', 'dataElementGroups', 'indicatorGroups', 'programs', 'dataSets', 'dashboards', 'visualizations', 'maps', 'eventReports', 'eventCharts'],
            description: 'The DHIS2 metadata type (plural form). Required for delete, check_references, and update_sharing.'
          },
          object_id: {
            type: 'string',
            description: 'The UID of the metadata object. Required for delete, check_references, and update_sharing.'
          },
          stage_id: {
            type: 'string',
            description: 'Program stage ID (required for remove_from_stage).'
          },
          data_element_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Data element IDs to remove from the stage (required for remove_from_stage).'
          },
          program_id: {
            type: 'string',
            description: 'Program UID for update_program_org_units. If omitted, object_id can be used instead.'
          },
          org_unit_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Organisation unit IDs for update_program_org_units.'
          },
          merge_mode: {
            type: 'string',
            enum: ['replace', 'add', 'remove'],
            description: 'How to apply org_unit_ids in update_program_org_units. replace=exactly these OUs, add=append to current set, remove=remove from current set. Default: replace.'
          },
          program_attributes: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Existing trackedEntityAttribute UID. If provided, uses this attribute as-is.' },
                name: { type: 'string', description: 'TEA display name. If no id given, the tool first tries to find an existing TEA with this exact name; if none exists, a new TEA is created.' },
                short_name: { type: 'string' },
                value_type: { type: 'string', description: 'Required when creating a new TEA. e.g. TEXT, NUMBER, DATE, BOOLEAN, PHONE_NUMBER, EMAIL, AGE, INTEGER_POSITIVE.' },
                option_set: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    options: { type: 'array', items: { type: 'string' } }
                  },
                  description: 'Optional inline option set for a newly-created TEA.'
                },
                searchable: { type: 'boolean', description: 'Mark as searchable in Capture/Tracker search. Default: false.' },
                display_in_list: { type: 'boolean', description: 'Show in TEI list columns. Default: true.' },
                mandatory: { type: 'boolean', description: 'Required at enrollment. Default: false.' }
              }
            },
            description: 'Attributes to add to an existing program (for add_program_attributes). Each entry may reference an existing TEA by id or name, or create a new one by supplying value_type (and optionally option_set).'
          },
          dry_run_only: {
            type: 'boolean',
            description: 'Validate without committing. Supported for update_program_org_units.'
          },
          public_access: {
            type: 'string',
            description: 'Public access string for update_sharing. Format: 8 chars, e.g. "rwrw----" (metadata+data rw), "rw------" (metadata only), "r-r-----" (read-only). Positions 1-2=metadata, 3-4=data.'
          },
          user_group_accesses: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'User group UID' },
                access: { type: 'string', description: 'Access string, e.g. "rwrw----"' }
              },
              required: ['id', 'access']
            },
            description: 'User group access entries for update_sharing. Each entry: {id: "<groupId>", access: "<accessString>"}.'
          },
          user_accesses: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'User UID' },
                access: { type: 'string', description: 'Access string, e.g. "rwrw----"' }
              },
              required: ['id', 'access']
            },
            description: 'Individual user access entries for update_sharing. Each entry: {id: "<userId>", access: "<accessString>"}.'
          },
          icon: {
            type: 'string',
            description: 'For update_style: an EXACT DHIS2 icon key (e.g. "syringe_positive", "clinical_f_positive") that you have just verified exists via manage_metadata(action=discover_icons,...) in THIS turn. The tool refuses keys that have not been verified — DHIS2 has a fixed library of ~900 icons and many obvious-sounding names ("tuberculosis_positive", "diabetes_positive", "vaccine_positive", "pregnancy_positive") DO NOT EXIST and will be rejected. Workflow: (1) call discover_icons with broad short keyword roots, (2) read the returned keys, (3) call update_style with one of those exact keys. Omit `icon` to leave icon unchanged.'
          },
          keywords: {
            type: 'array',
            items: { type: 'string' },
            description: 'For discover_icons: SHORT keyword roots to search the DHIS2 icon library against (e.g. ["lung","respir","tb","medical","clinic"]). DHIS2 icon search is prefix-on-keyword, so use ROOTS not full words: "preg" matches but "pregnancy" returns 0; "respir" matches but "respiratory" returns 0. Provide 4-8 broad candidates so you discover real icons in one call instead of guessing.'
          },
          color: {
            type: 'string',
            description: 'For update_style: hex color string for the display color, e.g. "#2196F3". Omit to leave color unchanged.'
          },
          value_type: {
            type: 'string',
            description: 'For convert_value_type: the new valueType (e.g. MULTI_TEXT, TEXT, LONG_TEXT). MULTI_TEXT = multi-select; the tool auto-cascades the change so the DE/TEA and its optionSet end up with the same valueType, since DHIS2 New Tracker Capture only renders multi-select UI when both sides are MULTI_TEXT.'
          },
          skip_backup: {
            type: 'boolean',
            description: 'DANGEROUS. Bypass the auto-backup that runs before every destructive manage_metadata action (delete, update_*, remove_from_stage, add_program_attributes). Only set true after the user has been told the backup step failed AND has explicitly authorized proceeding without recovery.'
          }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'manage_program_notifications',
      description: `Manage DHIS2 Program Notification Templates (list / get / create / update / delete / link / unlink / create_and_link). Use this INSTEAD of dhis2_query whenever the user asks to create, edit, attach, or send webhooks / emails / SMS / dashboard messages from a program.

DHIS2 2.36+ reality codified into this tool (do NOT re-derive these at runtime):
- ProgramNotificationTemplate has NO \`url\` / \`webhookUrl\` / \`hookUrl\` / \`targetUrl\` / \`endpoint\` field. DHIS2 silently drops unknown keys on POST, which is why PATCH with \`url\` returns 400.
- For WEB_HOOK recipient, the webhook URL is stored in \`messageTemplate\` (server convention) and \`deliveryChannels\` is auto-set to \`["HTTP"]\` by DHIS2's post-process hook. Pass \`webhook_url\` and the tool places it correctly.
- Linking a template to a program uses a dedicated collection endpoint: \`POST /api/programs/{programId}/notificationTemplates/{templateId}\` (NOT PATCH on the program, which fails 400 because the Program schema property is \`notificationTemplates\` not \`programNotificationTemplates\`).
- \`subjectTemplate\` max length = 100 chars. \`messageTemplate\` max = 10000. The tool will reject over-long values up front with a concrete \`_hint\`.
- Triggers: ENROLLMENT, COMPLETION, PROGRAM_RULE, SCHEDULED_DAYS_DUE_DATE, SCHEDULED_DAYS_INCIDENT_DATE, SCHEDULED_DAYS_ENROLLMENT_DATE (the SCHEDULED_* triggers REQUIRE \`relative_scheduled_days\`).
- Recipients: TRACKED_ENTITY_INSTANCE, ORGANISATION_UNIT_CONTACT, USERS_AT_ORGANISATION_UNIT, USER_GROUP, PROGRAM_ATTRIBUTE, DATA_ELEMENT, WEB_HOOK. USER_GROUP → needs \`recipient_user_group_id\`; PROGRAM_ATTRIBUTE → \`recipient_program_attribute_id\`; DATA_ELEMENT → \`recipient_data_element_id\`.

Typical "create a webhook for program X on enrollment" request → ONE call:
  manage_program_notifications(action="create_and_link", program_id="<pid>", name="...", trigger="ENROLLMENT", recipient="WEB_HOOK", webhook_url="https://...", message_content="Program: V{program_name} | OU: V{org_unit_name} | A{<teaUid>}")

Atomicity guarantee (create_and_link): if the template creates but the link fails, the tool auto-deletes the template so the server is returned to its pre-call state — no orphaned templates, ever. On partial failure the response contains a \`rollback\` field documenting what was undone. Pre-flight dedup also prevents duplicates when a template with the same name is already linked to the target program.

Orphan cleanup: \`manage_program_notifications(action="orphan_sweep")\` lists templates not linked to any program/stage; pass \`delete=true\` to remove them.

Returns: { template_id, linked_to_program, template: {...}, _notes: [...] }. On failure: { _error, _hint, rollback? } so the model can retry in one iteration.`,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'get', 'create', 'update', 'delete', 'link', 'unlink', 'create_and_link', 'orphan_sweep'],
            description: 'list = list templates for a program. get = fetch one by id. create = create a template (does NOT link to a program). update = PATCH fields on an existing template. delete = remove a template. link = attach a template to a program. unlink = detach. create_and_link = create + link atomically with auto-rollback on failure (recommended). orphan_sweep = find templates not linked to any program or stage; pass delete=true to remove them.'
          },
          delete: { type: 'boolean', description: 'For action=orphan_sweep: when true, delete every orphan found; when false (default), only report them.' },
          program_id: { type: 'string', description: 'Program UID. Required for list, link, unlink, create_and_link.' },
          template_id: { type: 'string', description: 'Template UID. Required for get, update, delete, link, unlink.' },
          name: { type: 'string', description: 'Template display name (required for create / create_and_link).' },
          trigger: {
            type: 'string',
            enum: ['ENROLLMENT', 'COMPLETION', 'PROGRAM_RULE', 'SCHEDULED_DAYS_DUE_DATE', 'SCHEDULED_DAYS_INCIDENT_DATE', 'SCHEDULED_DAYS_ENROLLMENT_DATE'],
            description: 'notificationTrigger. Required for create / create_and_link.'
          },
          recipient: {
            type: 'string',
            enum: ['TRACKED_ENTITY_INSTANCE', 'ORGANISATION_UNIT_CONTACT', 'USERS_AT_ORGANISATION_UNIT', 'USER_GROUP', 'PROGRAM_ATTRIBUTE', 'DATA_ELEMENT', 'WEB_HOOK'],
            description: 'notificationRecipient. Required for create / create_and_link.'
          },
          webhook_url: {
            type: 'string',
            description: 'For WEB_HOOK recipient: the HTTPS URL to POST to. Auto-placed into messageTemplate (DHIS2 has no dedicated url field). Mutually exclusive with message_template.'
          },
          message_content: {
            type: 'string',
            description: 'Body/content with template variables (V{program_name}, V{org_unit_name}, A{<teaUid>}, etc.). For WEB_HOOK it goes into subjectTemplate (≤100 chars) since messageTemplate holds the URL. For non-WEB_HOOK recipients it goes into messageTemplate.'
          },
          subject_template: { type: 'string', description: 'Override subjectTemplate directly (max 100 chars). Prefer message_content.' },
          message_template: { type: 'string', description: 'Override messageTemplate directly (max 10000 chars). Prefer webhook_url + message_content for WEB_HOOK.' },
          delivery_channels: {
            type: 'array',
            items: { type: 'string', enum: ['SMS', 'EMAIL', 'HTTP'] },
            description: 'Usually auto-inferred from recipient (WEB_HOOK→HTTP, PROGRAM_ATTRIBUTE/DATA_ELEMENT depend on valueType). Pass explicitly only to override.'
          },
          recipient_user_group_id: { type: 'string', description: 'Required when recipient=USER_GROUP.' },
          recipient_program_attribute_id: { type: 'string', description: 'Required when recipient=PROGRAM_ATTRIBUTE. Must be a TEA of valueType EMAIL or PHONE_NUMBER.' },
          recipient_data_element_id: { type: 'string', description: 'Required when recipient=DATA_ELEMENT. Must be a DE of valueType EMAIL or PHONE_NUMBER.' },
          relative_scheduled_days: { type: 'integer', description: 'Days offset from due/incident/enrollment date. Required for SCHEDULED_DAYS_* triggers. Negative = before, positive = after.' },
          send_repeatable: { type: 'boolean', description: 'Allow re-delivery of the same template to the same enrollment. Default: false.' },
          patch: {
            type: 'object',
            description: 'For action=update: object of fields to change. Supported keys: name, subject_template, message_template, webhook_url, message_content, trigger, recipient, send_repeatable, relative_scheduled_days. The tool converts to a JSON Patch body with application/json-patch+json. Do NOT include "url" — DHIS2 drops it.'
          },
          skip_backup: {
            type: 'boolean',
            description: 'DANGEROUS. Bypass the auto-backup that runs before every notification-template update/delete/orphan_sweep. Only set true after the user has been told the backup step failed AND has explicitly authorized proceeding without recovery.'
          }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'manage_datasets',
      description: `Manage DHIS2 dataSets — the aggregate-data equivalent of programs. Use this tool whenever the user asks to create, update, delete, list, inspect, or modify an "aggregate program", "dataset", "monthly form", "reporting form", or "data entry form". DataSets are what users mean by "aggregate program".

Actions:
- list — list datasets (optional name_filter, period_type filters; returns id, name, periodType, formType, DE/section/OU counts)
- get — full details of one dataset including DEs, sections, OUs, sharing
- create — create a new dataset atomically with optional data elements, sections, org units, indicators, and sharing. ALL components in ONE call. Auto-resolves the default categoryCombo. Defaults sharing to "rwrw----" so users can enter data immediately.
- update — patch dataset fields (name, short_name, description, period_type, form_type, open_future_periods, expiry_days, timely_days, render_as_tabs, render_horizontally, etc.)
- delete — delete a dataset (auto-backup, reference check)
- add_data_elements — append DEs to an existing dataset (no-op if already present); supports per-DE category-combo override via per_de_category_combo
- remove_data_elements — detach DEs from a dataset
- assign_org_units — set/add/remove OUs assigned to the dataset (merge_mode: replace | add | remove). Without OUs, the dataset is invisible in the Data Entry app.
- update_sharing — set public_access (8-char string, e.g. "rwrw----" for full data entry) plus user/group access entries. Critical for enabling data entry: positions 3-4 must be "rw".
- create_section / update_section / delete_section — manage sections within a dataset (sections group DEs in the entry form)

Period types (exact case): Daily, Weekly, WeeklyWednesday, WeeklyThursday, WeeklySaturday, WeeklySunday, BiWeekly, Monthly, BiMonthly, Quarterly, QuarterlyNov, SixMonthly, SixMonthlyApril, SixMonthlyNov, Yearly, FinancialApril, FinancialJuly, FinancialSep, FinancialOct, FinancialNov.

Form types: DEFAULT (single table), SECTION (sectioned form — best for routine reporting), CUSTOM (uses dataEntryForm), SECTION_MULTIORG.

DHIS2 quirks codified into this tool — do NOT re-derive them:
- shortName is hard-clamped to 50 chars (the tool truncates).
- mobile is auto-set to false (deprecated J2ME flag, schema-required).
- categoryCombo "default" UID differs per server — the tool auto-resolves via /api/categoryCombos?filter=name:eq:default. Pass category_combo_id only when overriding.
- per-DE categoryCombo override on dataSetElements lets one DE in the form use different disaggregation than the dataset default.
- Sections live in a separate /api/sections resource but the tool bundles them in the same /api/metadata POST so create is atomic.
- Sharing rwrw---- (positions 3-4 = data) is required for users to actually enter data; rw------ allows metadata edits only and the Save button silently no-ops.
- Auto-backup runs before every destructive op (delete, update_sharing, remove_data_elements, etc.) to dataStore/dhis2-ai-extension-backups.

Returns: { success, dataset_id, dataset_name, ... summary }. On failure: { _error, _hint, [backup] } so the model can recover without re-prompting.`,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'get', 'create', 'update', 'delete', 'add_data_elements', 'remove_data_elements', 'assign_org_units', 'update_sharing', 'create_section', 'update_section', 'delete_section'],
            description: 'Which dataset operation to perform.'
          },
          dataset_id: { type: 'string', description: 'DataSet UID. Required for get/update/delete/add_data_elements/remove_data_elements/assign_org_units/update_sharing/create_section.' },
          object_id: { type: 'string', description: 'Alias for dataset_id (so the model can use the same key as in manage_metadata).' },
          dataset_name: { type: 'string', description: 'Display name. Required for create. Must be unique server-wide.' },
          short_name: { type: 'string', description: 'Short name (≤ 50 chars). Defaults to dataset_name truncated. Used to render the dataset in compact UIs.' },
          code: { type: 'string', description: 'Optional alternate identifier code.' },
          description: { type: 'string', description: 'Optional description.' },
          period_type: {
            type: 'string',
            enum: ['Daily','Weekly','WeeklyWednesday','WeeklyThursday','WeeklySaturday','WeeklySunday','BiWeekly','Monthly','BiMonthly','Quarterly','QuarterlyNov','SixMonthly','SixMonthlyApril','SixMonthlyNov','Yearly','FinancialApril','FinancialJuly','FinancialSep','FinancialOct','FinancialNov'],
            description: 'How often data is collected. Required for create. Case-sensitive.'
          },
          form_type: {
            type: 'string',
            enum: ['DEFAULT','SECTION','CUSTOM','SECTION_MULTIORG'],
            description: 'How the data-entry form is rendered. Default DEFAULT for < 20 DEs; SECTION otherwise.'
          },
          category_combo_id: { type: 'string', description: 'Optional dataset-level categoryCombo UID. If omitted, uses the system "default" combo (auto-resolved). Set this for attribute disaggregation across the whole form (e.g., partner organisation as the dataset attribute).' },
          data_element_ids: {
            type: 'array', items: { type: 'string' },
            description: 'For create: DEs to attach. For add_data_elements / remove_data_elements: DEs to add or remove.'
          },
          per_de_category_combo: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: 'For create / add_data_elements: per-DE categoryCombo override map { "<deUid>": "<ccUid>", ... }. Use only when one DE needs a different disaggregation than the dataset default.'
          },
          data_set_elements: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                data_element_id: { type: 'string' },
                category_combo_id: { type: 'string' }
              },
              required: ['data_element_id']
            },
            description: 'Alternative explicit form for create: array of { data_element_id, category_combo_id? }. Mutually substitutable with data_element_ids + per_de_category_combo.'
          },
          org_unit_ids: {
            type: 'array', items: { type: 'string' },
            description: 'For create / assign_org_units: organisation-unit UIDs the dataset is available at. WITHOUT OUs, the dataset is invisible in any Data Entry app.'
          },
          merge_mode: {
            type: 'string', enum: ['replace','add','remove'],
            description: 'For assign_org_units. replace = exactly these OUs, add = append, remove = take away. Default replace.'
          },
          assign_all_org_units: {
            type: 'boolean',
            description: 'For create: assign every level-1 (root) OU on the server. Use sparingly — most production datasets need a curated OU list.'
          },
          indicator_ids: {
            type: 'array', items: { type: 'string' },
            description: 'For create / update / create_section: display indicators rendered on the form (read-only sums computed from DEs). NOT to be confused with program indicators.'
          },
          sections: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                description: { type: 'string' },
                sort_order: { type: 'integer' },
                data_element_ids: { type: 'array', items: { type: 'string' } },
                indicator_ids: { type: 'array', items: { type: 'string' } },
                show_row_totals: { type: 'boolean' },
                show_column_totals: { type: 'boolean' },
                disable_data_element_auto_group: { type: 'boolean' }
              },
              required: ['name']
            },
            description: 'For create: sections to bundle atomically with the dataset. Each section: { name, sort_order?, data_element_ids:[...], indicator_ids?:[], show_row_totals?, show_column_totals? }. Use form_type="SECTION" for these to render.'
          },
          // Section CRUD
          section_id: { type: 'string', description: 'Section UID. Required for update_section / delete_section.' },
          section_name: { type: 'string', description: 'For create_section: section display name.' },
          sort_order: { type: 'integer', description: 'For create_section / update_section: section ordering position.' },
          show_row_totals: { type: 'boolean' },
          show_column_totals: { type: 'boolean' },
          disable_data_element_auto_group: { type: 'boolean' },

          // Update fields
          patch: {
            type: 'object',
            description: 'For update: object of fields to change. Supported keys (snake_case): name, short_name, description, code, period_type, form_type, open_future_periods, expiry_days, timely_days, render_as_tabs, render_horizontally, mobile, valid_complete_only, compulsory_fields_complete_only, notify_completing_user, no_value_requires_comment, skip_offline, data_element_decoration, field_combination_required.'
          },

          // Sharing fields
          public_access: { type: 'string', description: 'For create / update_sharing: 8-char access string. Defaults to "rwrw----" (full metadata + DATA r/w) so users can enter data. Use "rw------" for metadata-only (data entry will silently not save). Use "r-r-----" for read-only.' },
          external_access: { type: 'boolean', description: 'For create / update_sharing: anonymous external access flag. Default false.' },
          metadata_only_sharing: { type: 'boolean', description: 'For create: when true, public_access defaults to "rw------" instead of "rwrw----" (use this for staging datasets you do NOT want users to enter data into yet).' },
          user_group_accesses: {
            type: 'array',
            items: { type: 'object', properties: { id: { type: 'string' }, access: { type: 'string' } }, required: ['id','access'] },
            description: 'For create / update_sharing: per-user-group access entries.'
          },
          user_accesses: {
            type: 'array',
            items: { type: 'object', properties: { id: { type: 'string' }, access: { type: 'string' } }, required: ['id','access'] },
            description: 'For create / update_sharing: per-user access entries.'
          },

          // Numeric dataset fields (create)
          open_future_periods: { type: 'integer', description: 'For create: how many future periods are open for data entry. 0 = none.' },
          expiry_days: { type: 'integer', description: 'For create: days after period end during which entry stays open. 0 = never expires.' },
          timely_days: { type: 'integer', description: 'For create: days after period end before submission is "late" (drives reporting-rate analytics). Default 15.' },
          render_as_tabs: { type: 'boolean' },
          render_horizontally: { type: 'boolean' },
          field_combination_required: { type: 'boolean' },
          valid_complete_only: { type: 'boolean' },
          compulsory_fields_complete_only: { type: 'boolean' },
          notify_completing_user: { type: 'boolean' },
          no_value_requires_comment: { type: 'boolean' },
          skip_offline: { type: 'boolean' },
          data_element_decoration: { type: 'boolean' },

          // List filters
          name_filter: { type: 'string', description: 'For list: case-insensitive substring filter on dataset name (ilike).' },
          limit: { type: 'integer', description: 'For list: max datasets to return (1–200, default 50).' },

          // Misc
          dry_run_only: { type: 'boolean', description: 'For create / update / assign_org_units: validate without committing (calls /api/metadata?importMode=VALIDATE).' },
          skip_backup: { type: 'boolean', description: 'DANGEROUS. Bypass the auto-backup that runs before every destructive manage_datasets action. Only set true after the user has been told the backup step failed AND has explicitly authorized proceeding without recovery.' }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'manage_custom_forms',
      description: `Author CUSTOM (HTML) data-entry forms for BOTH dataSets (aggregate) AND tracker/event program stages. Use this whenever the user asks to "create a custom form", "design a data entry form", "build a custom layout", "make an HTML form", or wants full control over how fields are laid out (tables, headings, narrative text between fields) beyond DEFAULT/SECTION forms.

Targets (pass exactly ONE):
- dataset_id — a dataSet → the form renders in the Aggregate Data Entry app.
- program_stage_id — a program stage (tracker OR event program) → the form renders in the Capture app.

Actions:
- get — inspect the current form: formType, linked dataEntryForm id/name/style, parsed input ids, html preview.
- preview_html — auto-generate a clean table-based htmlCode skeleton from the target's data elements and RETURN it WITHOUT saving (so you can show/edit it first).
- set_dataset_form — create/replace the custom form on a dataSet and flip formType to CUSTOM. Pass html_code, or omit it to auto-generate one input per data element × categoryOptionCombo.
- set_stage_form — create/replace the custom form on a program stage and flip formType to CUSTOM. Pass html_code, or omit to auto-generate one input per stage data element.
- remove_form — unlink the custom form and revert formType (new_form_type: DEFAULT | SECTION, default DEFAULT). Set delete_form_object:true to also delete the orphaned dataEntryForm.

Input-id binding (CRITICAL — the apps bind native widgets to these ids and render the rest of the HTML verbatim):
- dataset cell:      <input id="<dataElementUID>-<categoryOptionComboUID>-val" title="" value="">
- program-stage cell: <input id="<programStageUID>-<dataElementUID>-val" title="" value="">

DHIS2 quirks this tool encodes so you do NOT re-derive them (verified on 2.43):
- A dataEntryForm CANNOT be embedded inline. The tool ALWAYS creates it standalone via POST /api/dataEntryForms first, then references it — embedding {name,htmlCode} in a dataSet/programStage payload fails with E5002 "Invalid reference (DataEntryForm)".
- Linking to a program stage with PATCH or a naive PUT DROPS the program reference ("Program stage must reference a program"). The tool does a full PUT that re-attaches program:{id} (GET ?fields=:owner omits program).
- A dataset custom form only accepts data entry when sharing is rwrw---- (data write) AND at least one org unit is assigned — the tool reports these as hints but you fix them with manage_datasets (update_sharing / assign_org_units).
- Auto-backup runs before set_*/remove_form. style is one of NORMAL (default), COMFORTABLE, COMPACT, NONE.

Returns: { success, target, form_id, input_count, form_type, backup, _hints }. On failure: { _error, _hint } so you can recover without re-prompting.`,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['get', 'preview_html', 'set_dataset_form', 'set_stage_form', 'remove_form'],
            description: 'Which custom-form operation to perform.'
          },
          dataset_id: { type: 'string', description: 'DataSet UID. Use for dataset custom forms (get / preview_html / set_dataset_form / remove_form).' },
          object_id: { type: 'string', description: 'Alias for dataset_id.' },
          program_stage_id: { type: 'string', description: 'Program stage UID. Use for tracker/event program-stage custom forms (get / preview_html / set_stage_form / remove_form).' },
          stage_id: { type: 'string', description: 'Alias for program_stage_id.' },
          html_code: { type: 'string', description: 'For set_dataset_form / set_stage_form: the full custom-form HTML. Inputs MUST use the id binding format for the target (see description). If omitted, the tool auto-generates a clean table form from the target\'s data elements.' },
          form_name: { type: 'string', description: 'Optional dataEntryForm display name (unique server-wide). Defaults to "<target name> custom form". When updating an existing form, the existing name is kept unless this is set.' },
          style: { type: 'string', enum: ['NORMAL', 'COMFORTABLE', 'COMPACT', 'NONE'], description: 'Form rendering style. Default NORMAL.' },
          new_form_type: { type: 'string', enum: ['DEFAULT', 'SECTION'], description: 'For remove_form: what to revert formType to. Default DEFAULT.' },
          delete_form_object: { type: 'boolean', description: 'For remove_form: also DELETE the orphaned dataEntryForm object (default false — it is just unlinked).' },
          skip_backup: { type: 'boolean', description: 'DANGEROUS. Bypass the auto-backup before set_*/remove_form. Only after the user is told the backup failed AND authorizes proceeding.' }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'manage_custom_translations',
      description: `Translate or re-label the UI strings of ANY DHIS2 app using the experimental DHIS2 2.43 "custom-translations" datastore feature. Use this whenever the user asks to "translate the Capture app", "translate this app to Arabic/French/...", "change/relabel a UI string", "rename a button/label", or "customise the wording" of an app — WITHOUT touching the app's source code.

REQUIRES DHIS2 2.43+ (the apps only read this datastore namespace on 2.43 and later). On older servers the write is harmless but has no effect; the tool refuses with a clear message.

How it works (verified on 2.43 — the Capture app fetches BOTH keys at startup):
- A single registry key "controller" in dataStore namespace "custom-translations" maps each app slug to the locales it has custom translations for, e.g. { "capture": ["ar"] }. If an app/locale pair is NOT in the controller, the app NEVER loads its translations — this tool keeps the controller in sync automatically.
- One key per app+locale named "<slug>__<locale>" (double underscore), e.g. "capture__ar". Its value is a JSON object mapping each EXACT original English source string to its replacement string.
- At render time the app swaps each matching source string for its replacement.

Two modes (the feature treats both identically — it is a literal source→target string map):
- TRANSLATION: locale is a different language (e.g. "ar", "fr") → English source renders as the translated value.
- SAME-LANGUAGE REWRITE: locale is the language already in use (e.g. "en") → relabel/reword strings in place (e.g. "Report data" → "Submit report").

Actions:
- list — list the custom-translations namespace: the controller registry (which apps/locales are registered) and all translation keys.
- get — read one translation map. Pass app + locale; omit them to return just the controller registry. Warns if an app/locale is registered but its key is missing, or vice-versa.
- set — create/update translations for app + locale. Writes the "<slug>__<locale>" key AND registers the pair in the controller in one step. Merges into any existing map by default; pass replace:true to overwrite the whole map.
- remove — delete translations for app + locale (key + controller de-registration), or pass keys:[...] to drop only specific source strings.

CRITICAL string matching: each property name in translations must match the app's source string EXACTLY — same capitalisation, punctuation and whitespace — or that string will not be swapped. Read the exact on-screen English first.

Datastore keys are NOT covered by manage_backups (that tool only restores metadata objects), so set/remove return the pre-write state inline as previous_value / previous_controller for manual rollback.

Returns: { success, namespace, app, locale, key, ... } on success; { _error, _hint } on failure.`,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'get', 'set', 'remove'],
            description: 'list=show the namespace (controller registry + keys); get=read one translation map (or the controller if app/locale omitted); set=create/update translations for an app+locale; remove=delete an app+locale map or specific strings.'
          },
          app: { type: 'string', description: 'The app slug, e.g. "capture", "dashboard", "data-visualizer", "maps". Lowercased automatically. Required for set/remove; optional for get.' },
          locale: { type: 'string', description: 'Locale code. Use a different language to TRANSLATE (e.g. "ar", "fr", "pt_BR") or the current language to REWRITE strings in place (e.g. "en"). Required for set/remove; optional for get.' },
          translations: { type: 'object', description: 'For set: JSON object mapping each EXACT source string to its replacement string, e.g. {"Report data":"الإبلاغ عن البيانات","Get started with Capture app":"ابدأ مع برنامج الالتقاط"}. All values must be strings.', additionalProperties: { type: 'string' } },
          replace: { type: 'boolean', description: 'For set: when true, REPLACE the entire translation map for this app+locale. Default false = merge the provided pairs into the existing map.' },
          keys: { type: 'array', items: { type: 'string' }, description: 'For remove: drop only these specific source strings from the map (keeps the rest and the registration). Omit to remove the whole app+locale map and de-register it from the controller.' }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'manage_growth_chart_plugin',
      description: `Set up the WHO Capture Growth Chart plugin (App Hub app "Capture Growth Chart", key capture-growth-chart) end to end so it can render WHO growth charts on a tracker program's enrollment dashboard in the new Capture app. Use this whenever the user mentions the growth chart / growth monitoring plugin, WHO growth standards, anthropometry, weight-for-age / height-for-age / head-circumference charts, or asks to "set up / configure / install the growth chart plugin".

What it does (verified on DHIS2 2.43):
- status — report whether the plugin app is installed, the current captureGrowthChart/config, and which programs are configured/ready.
- install — install the plugin from the DHIS2 App Hub (POST /api/appHub/{versionId}, latest version compatible with the server). Idempotent.
- scaffold_program — create a ready-to-use tracker program for growth monitoring (Person TET, attributes First name/Last name/Gender[option set Male/Female]/Date of birth, and a repeatable stage with Weight/Height/Head circumference data elements), assigned to the given org unit. Use when the user has no suitable program.
- configure — the core action. For a target program (+ optional stage) it resolves the required metadata and writes/merges the dataStore key captureGrowthChart/config. It auto-detects, or accepts explicit ids for: dateOfBirth + gender tracked-entity attributes (and the female/male option CODES), optional firstName/lastName, and the weight/height/headCircumference data elements on the stage. Merges so multiple programs can be configured side by side.
- remove — remove one program from captureGrowthChart/config (program_id), or delete the whole config key (confirm_delete_all:true).

The config schema this tool writes to dataStore namespace "captureGrowthChart", key "config":
{ "metadata": { "attributes": { dateOfBirth, gender, firstName, lastName, femaleOptionCode, maleOptionCode }, "dataElements": { weight, height, headCircumference }, "programStageForGrowthChart": { "<programId>": "<programStageId>" } }, "settings": { usePercentiles, customReferences, weightInGrams, defaultIndicator } }

Hard requirements the plugin enforces (the tool validates these and refuses with a clear list if unmet): the program MUST expose a Date-of-birth (DATE) attribute and a Gender/sex attribute with an option set, and the stage MUST have weight + height + head-circumference data elements. If ANY of the three data elements is missing the chart will not display. weightInGrams is auto-set true when the weight data element is recorded in grams.

IMPORTANT — making the chart visible: this tool configures everything the plugin needs to FUNCTION, but the plugin widget must still be ADDED to the program's enrollment dashboard. That placement is owned by the Capture app / Tracker Plugin Configurator (an internal dataStore/capture layout this tool deliberately does NOT overwrite, to avoid corrupting the Capture cache). The tool returns the exact plugin source URL and the steps; relay them to the user. defaultIndicator is one of: wfa (weight-for-age), hcfa (head-circumference-for-age), lhfa (length/height-for-age), wflh (weight-for-length/height).

Returns { success, ... , dashboard_attach } on success; { _error, _hint } on failure.`,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'install', 'scaffold_program', 'configure', 'remove'],
            description: 'status=report install + config state; install=install the plugin from App Hub; scaffold_program=create a ready-to-use growth-monitoring program; configure=resolve metadata and write captureGrowthChart/config for a program; remove=remove a program from the config (or delete it all).'
          },
          program_id: { type: 'string', description: 'Target program UID for configure / remove. For configure this is the tracker program whose enrollment dashboard will show the chart.' },
          program_stage_id: { type: 'string', description: 'For configure: the program stage UID that holds the weight/height/head-circumference data elements. If omitted, the tool picks the program stage that contains them.' },
          attribute_ids: { type: 'object', description: 'For configure: explicit tracked-entity-attribute UIDs to override auto-detection. Keys: dateOfBirth, gender, firstName, lastName.', properties: { dateOfBirth: { type: 'string' }, gender: { type: 'string' }, firstName: { type: 'string' }, lastName: { type: 'string' } } },
          data_element_ids: { type: 'object', description: 'For configure: explicit data-element UIDs to override auto-detection. Keys: weight, height, headCircumference.', properties: { weight: { type: 'string' }, height: { type: 'string' }, headCircumference: { type: 'string' } } },
          female_option_code: { type: 'string', description: 'For configure: the gender option SET CODE that represents female (e.g. "Female"). Auto-detected from the gender attribute option set if omitted.' },
          male_option_code: { type: 'string', description: 'For configure: the gender option SET CODE that represents male (e.g. "Male"). Auto-detected if omitted.' },
          settings: { type: 'object', description: 'For configure: plugin settings to merge. Keys: usePercentiles (bool), customReferences (bool), weightInGrams (bool — auto-set from the weight DE name if omitted), defaultIndicator (one of wfa, hcfa, lhfa, wflh).', properties: { usePercentiles: { type: 'boolean' }, customReferences: { type: 'boolean' }, weightInGrams: { type: 'boolean' }, defaultIndicator: { type: 'string', enum: ['wfa', 'hcfa', 'lhfa', 'wflh'] } } },
          org_unit_id: { type: 'string', description: 'For scaffold_program: the org unit UID to assign the new program to (required for scaffold).' },
          program_name: { type: 'string', description: 'For scaffold_program: name of the new program. Default "Growth Monitoring".' },
          confirm_delete_all: { type: 'boolean', description: 'For remove: when true (and no program_id), delete the entire captureGrowthChart/config key.' }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'manage_validation_rules',
      description: `CRUD for DHIS2 Validation Rules — the aggregate-data quality checks that compare two expressions (leftSide vs rightSide) with an operator over a period, flagging data that violates the rule (e.g. "inpatient days ≤ available bed-days", "sum of sub-totals == grand total", "ANC 1st visits ≥ ANC 4th visits"). Use this tool for ALL validation-rule operations — NEVER assemble raw /metadata POST/PUT bodies via dhis2_query.
Actions: list / get / create / update / delete.
Both sides are DHIS2 expressions over data elements: #{dataElementUid} (all category-option-combos summed) or #{dataElementUid.cocUid} (one disaggregation); constants use C{constantUid}; numbers/operators (+ - * /) are allowed. The chatbot server-validates BOTH expressions via DHIS2's /expressions/description endpoint BEFORE saving — a malformed or unresolved expression is rejected at create/update time, never silently saved.
operator: equal_to, not_equal_to, greater_than, greater_than_or_equal_to, less_than, less_than_or_equal_to, compulsory_pair (both sides must have a value or neither), exclusive_pair (at most one side may have a value).
importance: HIGH | MEDIUM | LOW. missingValueStrategy per side: NEVER_SKIP (default — missing treated as 0), SKIP_IF_ANY_VALUE_MISSING, SKIP_IF_ALL_VALUES_MISSING.
NEVER invent dataElement/constant UIDs — reuse UIDs from search_metadata / manage_datasets / get results.`,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'get', 'create', 'update', 'delete'],
            description: 'list=paginated validation-rule list (optional name/importance/period filters); get=one rule with both sides; create=new rule; update=patch an existing rule; delete=remove a rule.'
          },
          rule_id: { type: 'string', description: 'Existing validation rule UID (required for get, update, delete).' },
          name_filter: { type: 'string', description: 'For list: case-insensitive ilike filter on rule name.' },
          importance: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'], description: 'For list: filter by importance. (For create/update set it inside the rule object.)' },
          period_type: { type: 'string', description: 'For list: filter by period type (Monthly, Quarterly, Yearly, … exact-case).' },
          limit: { type: 'integer', description: 'For list: max rules to return (1–200, default 50).' },
          rule: {
            type: 'object',
            description: 'Validation-rule definition (required for create; pass only the changed fields for update).',
            properties: {
              name: { type: 'string', description: 'Unique rule name.' },
              description: { type: 'string' },
              instruction: { type: 'string', description: 'Message shown when the rule is violated (what the user should do about it).' },
              importance: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'], description: 'Default MEDIUM.' },
              operator: { type: 'string', enum: ['equal_to', 'not_equal_to', 'greater_than', 'greater_than_or_equal_to', 'less_than', 'less_than_or_equal_to', 'compulsory_pair', 'exclusive_pair'], description: 'How leftSide is compared to rightSide.' },
              period_type: { type: 'string', description: 'Evaluation period type (Monthly, Quarterly, …, same 20 exact-case values as datasets). Default Monthly.' },
              left_expression: { type: 'string', description: 'leftSide expression, e.g. "#{deUid}" or "#{deUid.cocUid} + #{deUid2}".' },
              left_description: { type: 'string', description: 'Human label for the left side (auto-derived from DHIS2 if omitted).' },
              left_missing_strategy: { type: 'string', enum: ['NEVER_SKIP', 'SKIP_IF_ANY_VALUE_MISSING', 'SKIP_IF_ALL_VALUES_MISSING'], description: 'Default NEVER_SKIP.' },
              right_expression: { type: 'string', description: 'rightSide expression.' },
              right_description: { type: 'string', description: 'Human label for the right side (auto-derived from DHIS2 if omitted).' },
              right_missing_strategy: { type: 'string', enum: ['NEVER_SKIP', 'SKIP_IF_ANY_VALUE_MISSING', 'SKIP_IF_ALL_VALUES_MISSING'], description: 'Default NEVER_SKIP.' }
            }
          },
          dry_run_only: { type: 'boolean', description: 'For create: validate expressions + metadata import without committing. Default false.' },
          skip_backup: { type: 'boolean', description: 'DANGEROUS. Bypass the auto-backup before update/delete. Only after the user is told the backup failed AND explicitly authorizes proceeding without recovery.' }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'manage_org_units',
      description: `CRUD for DHIS2 Organisation Units — the facilities/chiefdoms/districts that make up the org-unit HIERARCHY (the tree every program, dataset, data value and enrollment is attached to). Use this tool for ALL org-unit structure work — creating a new facility under a parent, renaming/closing one, MOVING (re-parenting) a unit or subtree, or deleting a leaf — NEVER hand-assemble raw /metadata POST/PUT bodies via dhis2_query.
Actions: list / get / create / update / delete.
Hierarchy rules the tool enforces for you: every unit except the single root has exactly one parent; \`level\` and \`path\` are DERIVED by DHIS2 from the parent (you never set them) — a child of a level-3 chiefdom becomes level 4 automatically, and moving a unit re-computes level/path for it AND every descendant. create verifies the parent exists first; update validates a re-parent target (rejecting a move under the unit's own descendant, which would create a cycle) and auto-snapshots a backup before writing; delete refuses any unit that still has CHILDREN (re-parent or remove them first) and lets DHIS2's atomic delete block units that still hold data values / program assignments, surfacing the exact reason.
Dates: openingDate is required on create; openingDate/closedDate accept YYYY-MM-DD. NEVER invent parent UIDs — resolve them with manage_org_units(action=list) or search_metadata.
Fresh/empty instance: to create the FIRST org unit (the root, e.g. a country) call create with NO parent_id — allowed only while the instance has zero org units. Then build downward, passing each create's returned org_unit_id as the next child's parent_id.`,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'get', 'create', 'update', 'delete'],
            description: 'list=paginated org-unit list (optional name/level/parent filters); get=one unit with parent, child count, dates and contact info; create=new child unit under a parent; update=patch fields and/or move (re-parent); delete=remove a childless leaf unit.'
          },
          org_unit_id: { type: 'string', description: 'Existing org-unit UID (required for get, update, delete).' },
          parent_id: { type: 'string', description: 'For list: only return direct children of this parent UID. For create: the parent the new unit is placed under (can also be set inside org_unit).' },
          name_filter: { type: 'string', description: 'For list: case-insensitive ilike filter on org-unit name.' },
          level: { type: 'integer', description: 'For list: filter to a single hierarchy level (1=root/national, 2=district, …).' },
          limit: { type: 'integer', description: 'For list: max units to return (1–200, default 50).' },
          org_unit: {
            type: 'object',
            description: 'Org-unit definition (required for create; pass only the changed fields for update).',
            properties: {
              name: { type: 'string', description: 'Unit name (unique within DHIS2).' },
              short_name: { type: 'string', description: 'Short name (≤50 chars, unique). Defaults to name on create if omitted.' },
              parent_id: { type: 'string', description: 'Parent org-unit UID. REQUIRED on create. On update, supplying it MOVES (re-parents) the unit and all its descendants.' },
              opening_date: { type: 'string', description: 'Date the unit opened, YYYY-MM-DD. REQUIRED on create.' },
              closed_date: { type: 'string', description: 'Date the unit closed, YYYY-MM-DD. On update, pass an empty string to clear it.' },
              code: { type: 'string', description: 'Optional unique code.' },
              description: { type: 'string' },
              comment: { type: 'string' },
              address: { type: 'string' },
              email: { type: 'string' },
              phone_number: { type: 'string' },
              contact_person: { type: 'string' },
              url: { type: 'string' }
            }
          },
          dry_run_only: { type: 'boolean', description: 'For create: validate the metadata import (incl. parent reference) without committing. Default false.' },
          skip_backup: { type: 'boolean', description: 'DANGEROUS. Bypass the auto-backup before update/delete. Only after the user is told the backup failed AND explicitly authorizes proceeding without recovery.' }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'manage_indicators',
      description: `CRUD for DHIS2 aggregate Indicators — the calculated values shown in dashboards, pivot tables and maps, computed as (numerator / denominator) × the indicatorType factor (1, 100, 1000, …). Examples: "ANC coverage = ANC 1st visits ÷ expected pregnancies × 100", "case fatality rate", "facilities reporting rate". Use this tool for ALL aggregate-indicator work — NEVER assemble raw /metadata POST/PUT bodies via dhis2_query. (This is for AGGREGATE indicators; tracker/event program indicators are handled by manage_program_indicators.)
Actions: list / get / create / update / delete.
numerator and denominator are DHIS2 aggregate expressions: #{dataElementUid} (summed across all category-option-combos) or #{dataElementUid.cocUid} (one disaggregation); R{dataSetUid.REPORTING_RATE} for reporting rates; I{programIndicatorUid} to reuse a program indicator; C{constantUid} for constants; numeric literals and + - * / are allowed. For a plain count/sum use denominator "1". The chatbot server-validates BOTH expressions via DHIS2's /expressions/description endpoint BEFORE saving — a malformed or unresolved expression is rejected at create/update time, never silently saved.
indicator_type selects the scaling factor: "Number (Factor 1)" for a raw ratio/count, "Per cent" (×100) for a percentage, "Per thousand"/"Per ten thousand"/"Per hundred thousand" for rates. Pass its UID or exact name — the tool resolves and verifies it before writing.
NEVER invent dataElement / dataSet / programIndicator / constant UIDs — reuse UIDs from search_metadata / manage_datasets / get results.`,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'get', 'create', 'update', 'delete'],
            description: 'list=paginated indicator list (optional name / indicator_type filters); get=one indicator with both expressions; create=new indicator; update=patch an existing indicator; delete=remove an indicator.'
          },
          indicator_id: { type: 'string', description: 'Existing indicator UID (required for get, update, delete).' },
          name_filter: { type: 'string', description: 'For list: case-insensitive ilike filter on indicator name.' },
          indicator_type: { type: 'string', description: 'For list: filter by indicatorType (UID or exact name). (For create/update set it inside the indicator object.)' },
          limit: { type: 'integer', description: 'For list: max indicators to return (1–200, default 50).' },
          indicator: {
            type: 'object',
            description: 'Indicator definition (required for create; pass only the changed fields for update). To render the indicator colour-coded (traffic-light) on dashboards/pivots/maps, chain an existing legend set via legend_set_id (create it first with manage_legend_sets).',
            properties: {
              name: { type: 'string', description: 'Unique indicator name.' },
              short_name: { type: 'string', description: 'Short name (≤50 chars). Defaults to name on create if omitted.' },
              description: { type: 'string' },
              indicator_type: { type: 'string', description: 'indicatorType UID or exact name ("Number (Factor 1)", "Per cent", "Per thousand", …). REQUIRED on create.' },
              numerator: { type: 'string', description: 'Numerator expression, e.g. "#{anc1Uid}" or "#{deA} + #{deB}". REQUIRED on create.' },
              numerator_description: { type: 'string', description: 'Human label for the numerator (auto-derived from DHIS2 if omitted).' },
              denominator: { type: 'string', description: 'Denominator expression. Use "1" for a plain count/sum. REQUIRED on create.' },
              denominator_description: { type: 'string', description: 'Human label for the denominator (auto-derived from DHIS2 if omitted).' },
              annualized: { type: 'boolean', description: 'Annualize the value (scale to a full year based on the selected period). Default false.' },
              decimals: { type: 'integer', description: 'Fixed number of output decimals (0–5). Omit/null to inherit the system default.' },
              legend_set_id: { type: 'string', description: 'Attach an EXISTING legend set (its colour bands) so this indicator renders color-coded / traffic-light in dashboards, pivot tables and maps. Pass the `legend_set_id` returned by manage_legend_sets(action="create") — this is the legend-set → indicator chaining path. The set MUST already exist (verified before write); NEVER invent the UID and NEVER attempt the attach via a raw dhis2_query PATCH or manage_metadata (it has no legend action).' },
              legend_set_ids: { type: 'array', items: { type: 'string' }, description: 'Attach MULTIPLE existing legend sets (uncommon). Each entry must be an existing legend-set UID. On update, an empty array [] detaches all legend sets.' },
              legend_set_name: { type: 'string', description: 'Alternative to legend_set_id: attach an existing legend set by its EXACT unique name (resolved to a UID; refuses a 0-match or ambiguous multi-match).' }
            }
          },
          dry_run_only: { type: 'boolean', description: 'For create: validate expressions + indicatorType + metadata import without committing. Default false.' },
          skip_backup: { type: 'boolean', description: 'DANGEROUS. Bypass the auto-backup before update/delete. Only after the user is told the backup failed AND explicitly authorizes proceeding without recovery.' }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'manage_option_sets',
      description: `Full lifecycle CRUD for DHIS2 **option sets** — the reusable code/label pick-lists (drop-downs) that data elements and tracked-entity attributes use to constrain input to a fixed set of choices (e.g. "HIV Result: Positive/Negative/Inconclusive", "Sex: Male/Female"). Use this tool for ALL standalone option-set work — NEVER hand-assemble /metadata option bodies via dhis2_query.
Actions: list / get / create / update / add_options / remove_options / reorder_options / delete.
An option set has a valueType (the data type of its codes) and an ORDERED list of options; each option is a { code, name } pair — code is the value stored in data, name is the label shown to the user. Codes must be UNIQUE within a set.
- create: a brand-new standalone option set plus its options, imported atomically (VALIDATE then COMMIT).
- add_options / remove_options: append new options to, or delete options from, an EXISTING set (remove deletes the option objects, which auto-detaches them; it refuses to remove the last remaining option).
- reorder_options: set the display order of an existing set's options by listing their codes (or UIDs) in the desired order.
- update: patch the set's OWN fields (name / code / description / value_type) — does NOT change membership.
- delete: remove the whole set (and its options); refuses, with the exact blockers, if any data element or tracked-entity attribute still uses it.
Each update/add/remove/reorder/delete auto-snapshots a backup first (restore via manage_backups).
(To create an option set INLINE as part of a NEW data element in one shot, use create_metadata's option_set field instead. To CONVERT an existing set to MULTI_TEXT/etc. and cascade the change, use manage_metadata(action=convert_value_type). This tool owns the standalone option-set lifecycle.)
NEVER invent option-set or option UIDs — reuse UIDs from search_metadata / get results.`,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'get', 'create', 'update', 'add_options', 'remove_options', 'reorder_options', 'delete'],
            description: 'list=paginated option-set list (optional name / value_type filters); get=one set with its options in display order; create=new standalone set + options; update=patch the set\'s own fields; add_options=append options; remove_options=delete options; reorder_options=set option display order; delete=remove the whole set + its options.'
          },
          option_set_id: { type: 'string', description: 'Existing option set UID (required for get, update, add_options, remove_options, reorder_options, delete).' },
          name_filter: { type: 'string', description: 'For list: case-insensitive ilike filter on option-set name.' },
          value_type: { type: 'string', description: 'For list: filter by valueType (e.g. TEXT). (For create/update set it inside the option_set object.)' },
          limit: { type: 'integer', description: 'For list: max option sets to return (1–200, default 50).' },
          option_set: {
            type: 'object',
            description: 'Option-set definition (required for create; for update pass only the changed OWN fields).',
            properties: {
              name: { type: 'string', description: 'Unique option-set name.' },
              code: { type: 'string', description: 'Optional unique option-set code.' },
              description: { type: 'string' },
              value_type: { type: 'string', description: 'Data type of the option codes (TEXT, NUMBER, INTEGER, LETTER, BOOLEAN, MULTI_TEXT, …). Defaults to TEXT if omitted on create.' },
              options: { type: 'array', description: 'For create: the ordered options. Each { code, name }. Codes must be unique within the set.', items: { type: 'object', properties: { code: { type: 'string' }, name: { type: 'string' } } } }
            }
          },
          options: { type: 'array', description: 'For add_options: the new options to append, each { code, name }. New codes must not collide with the set\'s existing codes.', items: { type: 'object', properties: { code: { type: 'string' }, name: { type: 'string' } } } },
          option_codes: { type: 'array', description: 'For remove_options: the codes of the options to delete from the set. (Use option_ids to target by UID instead.)', items: { type: 'string' } },
          option_ids: { type: 'array', description: 'For remove_options: option UIDs to delete (alternative to option_codes). For reorder_options: may be used as the ordered list of option UIDs if order is omitted.', items: { type: 'string' } },
          order: { type: 'array', description: 'For reorder_options: the option codes (or UIDs) in the desired display order. Must cover every option currently in the set, each exactly once.', items: { type: 'string' } },
          dry_run_only: { type: 'boolean', description: 'For create: validate the metadata import without committing. Default false.' },
          skip_backup: { type: 'boolean', description: 'DANGEROUS. Bypass the auto-backup before update/add_options/remove_options/reorder_options/delete. Only after the user is told the backup failed AND explicitly authorizes proceeding without recovery.' }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'manage_legend_sets',
      description: `Full lifecycle CRUD for DHIS2 **legend sets** — the reusable colour-coded value bands that data elements, indicators, visualisations and maps use to render numeric values as a traffic-light / heat-map scale (e.g. ANC coverage shaded red 0–50, amber 50–80, green 80–100). Use this tool for ALL standalone legend-set work — NEVER hand-assemble /metadata legendSets bodies via dhis2_query.
Actions: list / get / create / add_legends / remove_legends / update / delete.
A legend set owns an ORDERED-by-value list of **legends**, each a { name, startValue, endValue, color } band. Ranges are half-open [startValue, endValue): a band covers values >= startValue and < endValue, so endValue of one band may equal startValue of the next without overlapping. \`color\` is an optional 6-digit hex (#RRGGBB). DHIS2 does NOT reject overlapping/gapped bands, so this tool WARNS about overlaps but never blocks on them.
- create: a brand-new legend set + its bands, imported atomically (VALIDATE then COMMIT). Supply explicit \`legend_set.legends\`, OR pass \`auto_bands:{ start, end, count }\` to generate \`count\` equal-width contiguous bands spanning start→end, default-coloured on a red→amber→green ramp (low→high). \`auto_bands.colors\`/\`auto_bands.names\` (length must equal count) override the defaults.
- add_legends / remove_legends: append bands to, or drop bands (by name or UID) from, an EXISTING set; refuses to remove the last remaining band.
- update: patch the set's OWN fields (name / code) only — does NOT change the bands.
- delete: remove the whole set (its legends cascade with it); refuses, with the exact blockers, if any data element, indicator, visualisation or map still uses it.
Each add_legends/remove_legends/update/delete auto-snapshots a backup first (restore via manage_backups).
NEVER invent legend-set or legend UIDs — reuse UIDs from search_metadata / get results.`,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'get', 'create', 'add_legends', 'remove_legends', 'update', 'delete'],
            description: 'list=paginated legend-set list (optional name filter); get=one set with its bands in value order; create=new set + bands (explicit or auto_bands); add_legends=append bands; remove_legends=drop bands; update=patch the set\'s own fields; delete=remove the whole set + its bands.'
          },
          legend_set_id: { type: 'string', description: 'Existing legend set UID (required for get, add_legends, remove_legends, update, delete).' },
          name_filter: { type: 'string', description: 'For list: case-insensitive ilike filter on legend-set name.' },
          limit: { type: 'integer', description: 'For list: max legend sets to return (1–200, default 50).' },
          legend_set: {
            type: 'object',
            description: 'Legend-set definition (required for create; for update pass only the changed OWN fields name/code).',
            properties: {
              name: { type: 'string', description: 'Unique legend-set name.' },
              code: { type: 'string', description: 'Optional unique legend-set code.' },
              legends: { type: 'array', description: 'For create (when auto_bands is not used): the colour bands. Each { name, startValue, endValue, color? }. endValue must be > startValue; band names must be unique within the set; color is an optional 6-digit hex.', items: { type: 'object', properties: { name: { type: 'string' }, startValue: { type: 'number' }, endValue: { type: 'number' }, color: { type: 'string', description: '6-digit hex like #FF0000 (optional).' } } } }
            }
          },
          auto_bands: {
            type: 'object',
            description: 'For create: generate count equal-width contiguous bands spanning start→end (an alternative to listing legends explicitly). Default colours follow a red→amber→green ramp from low to high.',
            properties: {
              start: { type: 'number', description: 'Low end of the scale (first band startValue).' },
              end: { type: 'number', description: 'High end of the scale (last band endValue). Must be > start.' },
              count: { type: 'integer', description: 'Number of equal-width bands (1–50).' },
              names: { type: 'array', description: 'Optional band names (length must equal count). Defaults to "start–end" range labels.', items: { type: 'string' } },
              colors: { type: 'array', description: 'Optional 6-digit hex colours (length must equal count). Defaults to a red→amber→green ramp.', items: { type: 'string' } }
            }
          },
          legends: { type: 'array', description: 'For add_legends: the new bands to append, each { name, startValue, endValue, color? }. New band names must not collide with the set\'s existing band names.', items: { type: 'object', properties: { name: { type: 'string' }, startValue: { type: 'number' }, endValue: { type: 'number' }, color: { type: 'string' } } } },
          legend_names: { type: 'array', description: 'For remove_legends: the names of the bands to drop. (Use legend_ids to target by UID instead.)', items: { type: 'string' } },
          legend_ids: { type: 'array', description: 'For remove_legends: band UIDs to drop (alternative to legend_names).', items: { type: 'string' } },
          dry_run_only: { type: 'boolean', description: 'For create: validate the metadata import without committing. Default false.' },
          skip_backup: { type: 'boolean', description: 'DANGEROUS. Bypass the auto-backup before add_legends/remove_legends/update/delete. Only after the user is told the backup failed AND explicitly authorizes proceeding without recovery.' }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'manage_dashboards',
      description: `Build and inspect DHIS2 **analytics dashboards and visualizations** — the charts, pivot tables and single-value tiles shown in the Dashboard app, and the dashboards that arrange them. Use this tool for ALL dashboard/visualization CREATION — NEVER hand-assemble /metadata visualizations or dashboards bodies via dhis2_query (a raw POST that only sets columns/rows/filters silently imports an EMPTY, un-renderable chart — DHIS2 stores the layout as columnDimensions/rowDimensions/filterDimensions and the data as dataDimensionItems / relativePeriods / organisationUnits; this tool assembles that exact structure for you).
Actions: list / get / create_visualization / create_dashboard / add_items / remove_item / update / delete.
- create_visualization: one chart, pivot table or single-value tile. Supply name, vis_type (COLUMN, STACKED_COLUMN, BAR, STACKED_BAR, LINE, AREA, PIE, RADAR, GAUGE, SINGLE_VALUE, PIVOT_TABLE, YEAR_OVER_YEAR_LINE, …), data_items (aggregate indicator / AGGREGATE-domain dataElement / programIndicator UIDs — types are auto-resolved AND verified), periods (relative keywords like LAST_12_MONTHS or fixed ISO like 202401), and org_units (UIDs and/or USER_ORGUNIT, USER_ORGUNIT_CHILDREN, LEVEL-2). Layout (which of dx/pe/ou sits on columns/rows/filters) defaults sensibly per vis_type; override with layout if needed. ⚠ data_items must be AGGREGATE dimensions: a TRACKER data element or a tracked-entity attribute CANNOT be plotted directly (the tile renders an error) — first create a PROGRAM INDICATOR (manage_program_indicators) that aggregates it, then plot that program indicator's UID. The tool refuses a raw tracker data element with this guidance.
- create_dashboard: a whole NEW dashboard in ONE atomic import. Each entry in items either references an EXISTING visualization/map by UID, or inline-creates a NEW visualization (same fields as create_visualization). Items are auto-arranged on the 58-column grid. New visualizations and the dashboard import together (VALIDATE then COMMIT) so a single bad UID rolls the whole thing back.
- add_items: add chart(s)/map(s)/line-list(s)/text to an EXISTING dashboard WITHOUT destroying what's already there. Provide dashboard_id + items[] (each item: { visualization_id } to embed an existing chart, { new_visualization:{…} } to create+embed a new one, { type:"MAP", map_id }, { type:"EVENT_VISUALIZATION", event_visualization_id } to embed a saved line list from manage_line_lists, or { type:"TEXT", text }). This is the ONLY safe way to add to an existing dashboard — it reads the full dashboard, appends, and writes the complete item set back (a raw dashboard PUT would REPLACE and WIPE the existing tiles). It snapshots the dashboard to backups first.
- remove_item: drop one tile by item_id (get the dashboard first to see item ids). update: change a dashboard's name/description. delete: remove a whole dashboard. All three snapshot first and are restorable via manage_backups.
- list / get: list dashboards (optional name filter) / read one dashboard with its items (each item's id, type, and referenced visualization/map).
Every mutating action is backed up first (undo via manage_backups). For sharing use manage_metadata(action=update_sharing). NEVER invent visualization, map or data-item UIDs — resolve them with search_metadata / get results first.`,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'get', 'create_visualization', 'create_dashboard', 'add_items', 'remove_item', 'update', 'delete'],
            description: 'list=dashboard list; get=one dashboard with items; create_visualization=one chart/pivot/single-value; create_dashboard=a NEW dashboard with items; add_items=safely APPEND item(s) to an EXISTING dashboard (never wipes existing tiles); remove_item=drop one tile; update=edit dashboard name/description; delete=remove a whole dashboard. All mutating actions snapshot to backups first.'
          },
          dashboard_id: { type: 'string', description: 'Existing dashboard UID (required for get, add_items, remove_item, update, delete).' },
          item_id: { type: 'string', description: 'For remove_item: the dashboardItem UID to drop (see action=get for item ids).' },
          name_filter: { type: 'string', description: 'For list: case-insensitive ilike filter on dashboard name.' },
          limit: { type: 'integer', description: 'For list: max dashboards to return (1–200, default 50).' },
          visualization: {
            type: 'object',
            description: 'For create_visualization: the visualization spec.',
            properties: {
              name: { type: 'string', description: 'Visualization display name (required).' },
              vis_type: { type: 'string', description: 'Chart type: COLUMN, STACKED_COLUMN, BAR, STACKED_BAR, LINE, AREA, STACKED_AREA, PIE, RADAR, GAUGE, SINGLE_VALUE, PIVOT_TABLE, YEAR_OVER_YEAR_LINE, YEAR_OVER_YEAR_COLUMN, SCATTER, BUBBLE. Default COLUMN.' },
              data_items: { type: 'array', items: { type: 'string' }, description: 'Indicator / dataElement / programIndicator UIDs to plot (the dx dimension). Types are auto-resolved and existence-verified.' },
              periods: { type: 'array', items: { type: 'string' }, description: 'Periods (the pe dimension): relative keywords (LAST_12_MONTHS, THIS_YEAR, LAST_4_QUARTERS, …) and/or fixed ISO periods (202401, 2025Q1, 2025).' },
              org_units: { type: 'array', items: { type: 'string' }, description: 'Org units (the ou dimension): UIDs and/or relative keywords USER_ORGUNIT, USER_ORGUNIT_CHILDREN, USER_ORGUNIT_GRANDCHILDREN, or LEVEL-<n> (e.g. LEVEL-2).' },
              short_name: { type: 'string', description: 'Optional short name (max 50 chars).' },
              description: { type: 'string', description: 'Optional description.' },
              layout: {
                type: 'object',
                description: 'Optional layout override — which dimensions sit on each axis. Each is a subset of ["dx","pe","ou"]. Defaults: pivot → columns[pe] rows[dx] filters[ou]; single-value/gauge/pie → columns[dx] filters[pe,ou]; charts → columns[dx] rows[pe] filters[ou].',
                properties: {
                  columns: { type: 'array', items: { type: 'string' } },
                  rows: { type: 'array', items: { type: 'string' } },
                  filters: { type: 'array', items: { type: 'string' } }
                }
              }
            }
          },
          dashboard: {
            type: 'object',
            description: 'For create_dashboard (name required) and update (name and/or description to change).',
            properties: {
              name: { type: 'string', description: 'Dashboard display name.' },
              description: { type: 'string', description: 'Optional description.' }
            }
          },
          items: {
            type: 'array',
            description: 'For create_dashboard (items to place on a NEW dashboard) AND add_items (items to APPEND to an existing dashboard). Each entry either references an existing object OR inline-creates a new visualization.',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['VISUALIZATION', 'MAP', 'EVENT_VISUALIZATION', 'TEXT'], description: 'Item type. Default VISUALIZATION. Use TEXT for a free-text tile, MAP to embed an existing map, EVENT_VISUALIZATION to embed a saved line list (create with manage_line_lists).' },
                visualization_id: { type: 'string', description: 'UID of an EXISTING visualization to embed (type VISUALIZATION).' },
                map_id: { type: 'string', description: 'UID of an EXISTING map to embed (type MAP).' },
                event_visualization_id: { type: 'string', description: 'UID of an EXISTING saved line list / event visualization to embed (type EVENT_VISUALIZATION). line_list_id is accepted as an alias.' },
                text: { type: 'string', description: 'Tile text (type TEXT).' },
                new_visualization: {
                  type: 'object',
                  description: 'Inline-create a NEW visualization for this item (same fields as the create_visualization "visualization" spec): name, vis_type, data_items, periods, org_units, short_name, description, layout.'
                },
                x: { type: 'integer', description: 'Optional grid x (0–58). Auto-placed if omitted.' },
                y: { type: 'integer', description: 'Optional grid y. Auto-placed if omitted.' },
                width: { type: 'integer', description: 'Optional grid width (default 29 = half row).' },
                height: { type: 'integer', description: 'Optional grid height (default 20).' }
              }
            }
          },
          dry_run_only: { type: 'boolean', description: 'For create_visualization / create_dashboard: validate the metadata import without committing. Default false.' },
          skip_backup: { type: 'boolean', description: 'DANGEROUS. Bypass the mandatory pre-write snapshot on add_items/remove_item/update/delete. Only after the user is told the backup failed AND explicitly authorizes proceeding without recovery.' }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'manage_maps',
      description: `Create and inspect DHIS2 **thematic maps** (choropleth / bubble layers) — the shaded-by-value maps shown in the Maps app and embedded on dashboards. Use this tool for ALL map CREATION — DHIS2 has NO simple "create map" object, so NEVER hand-assemble a /api/maps body via dhis2_query (the layer's data goes on the mapView's columns[dx]/rows[ou]/filters[pe], with organisationUnitLevels, and a program attached for program-indicator layers — this tool assembles that exact structure, verified on play 2.43.0.1).
- create: one thematic map layer. Supply name, data_item (ONE indicator / dataElement / programIndicator UID — its type is auto-resolved AND verified, and the owning program is auto-attached for a program indicator), org_unit_level (e.g. 2 to shade every district) and/or org_units (parent UIDs or USER_ORGUNIT as the boundary), period (relative keyword like LAST_12_MONTHS or fixed like 202401), optional legend_set_id (create it first with manage_legend_sets for fixed colour bands — otherwise equal-interval auto colours), optional thematic_map_type (CHOROPLETH default, or BUBBLE), classes, color_scale, basemap. Returns map_id.
- list / get: list maps (optional name filter) / read one map with its layers, data item, org-unit levels, program and legend set.
- delete: remove a map (snapshots a backup first; restore via manage_backups).
To place a new map on a dashboard, pass its map_id to manage_dashboards(action="add_items", items=[{ type:"MAP", map_id }]) or reference it in a create_dashboard item. NEVER invent map, data-item or legend-set UIDs — resolve them via search_metadata / a prior tool result. For non-thematic layers (facilities, boundaries, Earth Engine) use the Maps app UI.`,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'get', 'create', 'delete'],
            description: 'list=recent maps (optional name filter); get=one map with its layers; create=new thematic map; delete=remove a map (auto-backup first).'
          },
          map_id: { type: 'string', description: 'Map UID (required for get / delete). A Maps app URL is also accepted.' },
          name: { type: 'string', description: 'For create: the map display name (required).' },
          data_item: { type: 'string', description: 'For create: the ONE indicator / data element / program indicator UID to shade the map by (the dx dimension). Type auto-resolved + existence-verified; the program is auto-attached for a program indicator.' },
          org_unit_level: { type: 'integer', description: 'For create: the org-unit LEVEL to shade (e.g. 2 = districts, 3 = chiefdoms). Every OU at this level under the boundary gets a colour.' },
          org_units: { type: 'array', items: { type: 'string' }, description: 'For create: boundary/parent org units — UIDs and/or USER_ORGUNIT / LEVEL-<n>. Combine with org_unit_level to shade that level within these parents. Defaults to shading the given level nationwide if omitted.' },
          period: { type: 'string', description: 'For create: a single period — relative keyword (LAST_12_MONTHS, THIS_YEAR, LAST_4_QUARTERS, …) or fixed ISO (202401, 2025Q1, 2025). Default LAST_12_MONTHS.' },
          legend_set_id: { type: 'string', description: 'For create (optional): a legend set UID for fixed colour bands (make one with manage_legend_sets). Omit for equal-interval auto colours.' },
          thematic_map_type: { type: 'string', enum: ['CHOROPLETH', 'BUBBLE'], description: 'For create: CHOROPLETH (shaded areas, default) or BUBBLE (proportional circles).' },
          classes: { type: 'integer', description: 'For create (optional): number of colour classes for auto (equal-interval) legends. Default 5.' },
          color_scale: { type: 'string', description: 'For create (optional): DHIS2 colour scale id (e.g. YlOrRd, Blues, Reds). Default YlOrRd.' },
          basemap: { type: 'string', description: 'For create (optional): basemap id (osmLight default, osmDetailed, …).' },
          name_filter: { type: 'string', description: 'For list: case-insensitive ilike filter on map name.' },
          limit: { type: 'integer', description: 'For list: max maps to return (1–200, default 50).' },
          program_id: { type: 'string', description: 'For create (optional): owning program UID for a program-indicator/event layer. Auto-derived from a program indicator when omitted.' },
          skip_backup: { type: 'boolean', description: 'DANGEROUS. Bypass the auto-backup before delete. Only after the user is told the backup failed AND explicitly authorizes proceeding without recovery.' }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'manage_line_lists',
      description: `Author and manage DHIS2 **line lists** — the saved row-per-record tables of the Line Listing app (stored as /api/eventVisualizations with type LINE_LIST). Use this tool for ALL saved-line-list CREATION/UPDATE — NEVER hand-assemble eventVisualizations bodies via dhis2_query (the persisted layout is columns/filters axes + derived dataElementDimensions/attributeDimensions/programIndicatorDimensions/simpleDimensions/repetitions, and a malformed body saves an object the app cannot open). This tool resolves every dimension against the program's REAL metadata, validates filters/repetitions/legends mechanically, and PROVES the layout runs (the same analytics query the app issues) BEFORE saving — a bad spec creates nothing.
Actions: list / get / create / update / delete / validate.
- create: one saved line list. Supply name, output_type (EVENT = one row per event of ONE stage; ENROLLMENT = one row per enrollment with cross-stage + repeated-event columns; TRACKED_ENTITY = one row per person), program_id (or exact program_name), program_stage_id for EVENT on multi-stage tracker programs, columns[] and optional filters[] (see column spec below), optional sorting[], legend, completed_only, data_check.
- update: change an existing list by line_list_id — pass columns/filters to REBUILD the layout (same spec as create), or just name/description/sorting/legend to touch own fields. Auto-backup first.
- validate: re-run an existing saved list's analytics query → row_count + headers (use after data/analytics changes or to diagnose "the line list shows an error").
- get / list: readable breakdown (decoded filters, stages, repetitions, legend) / recent line lists.
- delete: remove a saved line list (refuses while a dashboard still shows it; auto-backup first).
COLUMN/FILTER SPEC — each entry is a string or object:
- Org units: { dimension:"ou", org_units:["USER_ORGUNIT" | "LEVEL-4" | "<ouUid>" | "OU_GROUP-<uid>", …] } (required somewhere: every line list needs an org-unit boundary).
- Time: { dimension:"event_date"|"enrollment_date"|"incident_date"|"scheduled_date"|"last_updated", periods:["LAST_12_MONTHS","2026Q1","202605", …] } (EVENT/ENROLLMENT lists need one; time dims differ per output_type).
- Data element / attribute / program indicator: pass the UID or EXACT display name — the type and (for DEs) the stage are auto-resolved; add program_stage_id only when a DE lives in several stages. Optional filter: {operator:"IN"|"EQ"|"NE"|"GT"|"GE"|"LT"|"LE"|"LIKE", value | values:[…]} — option-set values are auto-mapped NAME→CODE, booleans to 1/0.
- Repeated events (ENROLLMENT output + repeatable stage only): add repeated_events:{ most_recent:2, oldest:2 } (or repetition_indexes:[1,2,-1,0]; 1=first, 0=latest, -1=second-latest) to a DE column to show one column per event occurrence.
- Statuses: { dimension:"event_status"|"program_status", statuses:["ACTIVE","COMPLETED",…] }.
⚠ Program-indicator columns are evaluated PER ROW: a rate/percentage PI with a division 409s the whole table when any row's denominator is 0 — the tool refuses those and tells you to build a count/flag PI with manage_program_indicators instead. PI analyticsType must match output_type (EVENT↔EVENT, ENROLLMENT↔ENROLLMENT), and count-style PIs need aggregation_type SUM (COUNT renders a constant 1 per row; NONE breaks the query and is refused).
Legend: legend:{ legend_set_id | legend_set_name, style:"FILL"|"TEXT", strategy:"FIXED"|"BY_DATA_ITEM", show_key } — create the set first with manage_legend_sets.
Place a saved line list on a dashboard via manage_dashboards items [{ type:"EVENT_VISUALIZATION", event_visualization_id }]. For UI navigation help in the Line Listing app use line_listing_guide; for ad-hoc event/enrollment COUNTS use get_event_analytics — this tool SAVES reusable line lists.`,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'get', 'create', 'update', 'delete', 'validate'],
            description: 'list=recent saved line lists (filters: name_filter, program_id); get=readable breakdown of one; create=new saved line list (validated + probed BEFORE saving); update=rebuild layout or touch own fields (auto-backup); delete=remove (refuses while on a dashboard; auto-backup); validate=re-run its analytics query → row_count/headers.'
          },
          line_list_id: { type: 'string', description: 'eventVisualization UID (required for get / update / delete / validate).' },
          name: { type: 'string', description: 'For create (required) / update: the saved line list title.' },
          description: { type: 'string', description: 'Optional description shown in the app\'s file details.' },
          output_type: { type: 'string', enum: ['EVENT', 'ENROLLMENT', 'TRACKED_ENTITY'], description: 'EVENT = one row per event of ONE stage (default). ENROLLMENT = one row per enrollment; columns may come from any stage and repeatable-stage columns can show several event occurrences. TRACKED_ENTITY = one row per person (attributes + org unit only).' },
          program_id: { type: 'string', description: 'The program UID the line list is built on (required for create unless program_name resolves uniquely).' },
          program_name: { type: 'string', description: 'Exact program name — resolved to program_id when unique.' },
          program_stage_id: { type: 'string', description: 'For EVENT output on a multi-stage tracker program: the stage whose events become rows. Stage NAME also accepted. Auto-resolved when the program has one stage.' },
          columns: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                dimension: { type: 'string', description: '"ou" | a time keyword (event_date, enrollment_date, incident_date, scheduled_date, last_updated) | "event_status"/"program_status" | a DE/attribute/program-indicator UID or EXACT display name.' },
                org_units: { type: 'array', items: { type: 'string' }, description: 'For dimension "ou": UIDs and/or USER_ORGUNIT, USER_ORGUNIT_CHILDREN, USER_ORGUNIT_GRANDCHILDREN, LEVEL-<n>, OU_GROUP-<uid>.' },
                periods: { type: 'array', items: { type: 'string' }, description: 'For a time dimension: relative keywords (LAST_12_MONTHS, THIS_YEAR, LAST_4_QUARTERS, …) and/or fixed ISO periods (202605, 2026Q1, 2026).' },
                statuses: { type: 'array', items: { type: 'string' }, description: 'For event_status (ACTIVE, COMPLETED, SCHEDULE, OVERDUE, SKIPPED) or program_status (ACTIVE, COMPLETED, CANCELLED).' },
                program_stage_id: { type: 'string', description: 'Stage UID or name — only needed when the data element appears in several stages.' },
                filter: { description: 'Condition on this dimension: { operator, value | values:[…] } or a raw "OP:value" string. Option-set values auto-map name→code; booleans → true/false.', type: 'object', properties: { operator: { type: 'string' }, value: {}, values: { type: 'array' } } },
                repeated_events: { type: 'object', properties: { most_recent: { type: 'integer' }, oldest: { type: 'integer' } }, description: 'ENROLLMENT output + repeatable stage only: how many latest/earliest event occurrences of this DE to show as separate columns. Or pass repetition_indexes:[1,2,-1,0].' },
                repetition_indexes: { type: 'array', items: { type: 'integer' }, description: 'Explicit occurrence indexes: 1=first, 2=second, …; 0=latest, -1=second-latest.' },
                allow_risky_program_indicator: { type: 'boolean', description: 'Override the division-PI refusal for THIS column — only when certain the per-row denominator can never be 0.' }
              }
            },
            description: 'The table columns, in order. Strings allowed as shorthand for { dimension:"…" }. Must include an org-unit dimension and (for EVENT/ENROLLMENT) a time dimension somewhere in columns+filters.'
          },
          filters: { type: 'array', items: { type: 'object', properties: { dimension: { type: 'string' }, org_units: { type: 'array' }, periods: { type: 'array' }, statuses: { type: 'array' }, program_stage_id: { type: 'string' }, filter: { type: 'object' } } }, description: 'Same spec as columns, but the dimension constrains the rows WITHOUT showing as a column.' },
          sorting: { type: 'array', items: { type: 'object', properties: { dimension: { type: 'string' }, direction: { type: 'string', enum: ['ASC', 'DESC'] } } }, description: 'Sort order; each dimension must be one of the columns (name, UID or time keyword accepted).' },
          legend: { type: 'object', properties: { legend_set_id: { type: 'string' }, legend_set_name: { type: 'string' }, style: { type: 'string', enum: ['FILL', 'TEXT'] }, strategy: { type: 'string', enum: ['FIXED', 'BY_DATA_ITEM'] }, show_key: { type: 'boolean' } }, description: 'Colour numeric cells: FIXED = one legend set for the whole list (pass legend_set_id/name); BY_DATA_ITEM = each item\'s own legend set. style FILL = cell background.' },
          completed_only: { type: 'boolean', description: 'Only completed events/enrollments.' },
          data_check: { type: 'string', enum: ['warn_empty', 'require_rows', 'skip'], description: 'create/update probe policy. warn_empty (default): refuse to save if the query FAILS, warn if it returns 0 rows. require_rows: also refuse on 0 rows. skip: no probe (offline analytics).' },
          name_filter: { type: 'string', description: 'For list: case-insensitive name filter.' },
          limit: { type: 'integer', description: 'For list: max results (1–200, default 50).' },
          skip_backup: { type: 'boolean', description: 'DANGEROUS. Bypass the auto-backup before update/delete. Only after the user is told the backup failed AND explicitly authorizes proceeding without recovery.' }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'manage_backups',
      description: `List, inspect, restore, delete, or purge metadata backups created automatically before destructive operations.

Every update/delete on programs, data elements, OUs, program rules, indicators, notification templates, sharing, etc. triggers an auto-snapshot to the DHIS2 dataStore namespace "${BACKUP_NAMESPACE}" BEFORE the write commits. Use this tool when:
- The user asks to undo a recent change ("revert", "rollback", "restore", "I deleted X by mistake") → action=list to find the right key, then action=restore.
- The user asks what backups exist or wants to clean them up → action=list, action=purge_old, or action=delete.
- The user wants to inspect what was captured → action=get.

Backups are kept for ${BACKUP_RETENTION_DAYS} days by default. action=purge_old deletes anything older than retention_days (default ${BACKUP_RETENTION_DAYS}).

Restore behavior: re-POSTs the "before" snapshot via /api/metadata?importStrategy=CREATE_AND_UPDATE&atomicMode=ALL. Tombstone entries (objects that were already gone at snapshot time) are skipped. Restore is idempotent — running it twice is safe.`,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'get', 'restore', 'delete', 'purge_old'],
            description: 'list=show recent backups (newest first); get=read one backup entry; restore=re-apply a backup; delete=remove one backup key; purge_old=delete all backups older than retention_days.'
          },
          backup_key: { type: 'string', description: 'Required for get/restore/delete. The full key like "backup-20260424T120000Z-delete-abc123".' },
          limit: { type: 'integer', description: 'For list: max keys to return (1–500, default 50).' },
          since: { type: 'string', description: 'For list: ISO timestamp; only return backups created at or after this time.' },
          operation: { type: 'string', description: 'For list: filter by operation slug embedded in the key (e.g. "delete", "update", "remove_from_stage").' },
          preview: { description: 'For list: when true (or a number), hydrate the first N keys with their entry summary. Costs extra round-trips so leave undefined for fast listing.', oneOf: [{ type: 'boolean' }, { type: 'integer' }] },
          retention_days: { type: 'integer', description: `For purge_old: keep entries newer than this many days (default ${BACKUP_RETENTION_DAYS}).` }
        },
        required: ['action']
      }
    }
  }
];

// `rules` (batch create) shares the exact schema of `rule` — attached
// programmatically so the wire schema and the dispatcher (args.rules) can
// never drift apart. Without this declaration, grammar-constrained providers
// could not emit rule fields at all (observed live 2026-07-18: 22 consecutive
// `rules:[{}]` calls from a constrained decoder that had no spec for `rules`).
{
  const _mpr = TOOLS.find(t => t.function.name === 'manage_program_rules');
  if (_mpr && _mpr.function.parameters?.properties?.rule) {
    _mpr.function.parameters.properties.rules = {
      type: 'array',
      description: 'Batch form of `rule` for action=create: an array of rule objects (same fields as `rule`). Prefer ≤15 rules per call so the payload streams reliably.',
      items: _mpr.function.parameters.properties.rule,
    };
  }
}


const TOOL_ROUTER = Object.freeze({
  dhis2_query: true,
  count_records: true,
  get_event_analytics: true,
  get_program_info: true,
  get_program_recent_changes: true,
  search_metadata: true,
  resolve_option_codes: true,
  detect_enrollment_abnormalities: true,
  cross_stage_entity_intersection: true,
  line_listing_guide: true,
  get_visualization_details: true,
  get_map_details: true,
  browse_web: true,
  render_chart: true,
  create_metadata: true,
  architect_metadata: true,
  manage_program_rules: true,
  manage_program_indicators: true,
  manage_metadata: true,
  manage_program_notifications: true,
  manage_datasets: true,
  manage_custom_forms: true,
  manage_custom_translations: true,
  manage_growth_chart_plugin: true,
  manage_validation_rules: true,
  manage_org_units: true,
  manage_indicators: true,
  manage_option_sets: true,
  manage_legend_sets: true,
  manage_dashboards: true,
  manage_maps: true,
  manage_line_lists: true,
  manage_backups: true,
});

// ── Lazy Tool Manuals (two-tier tool docs) ───────────────────────────────────
// Progressive disclosure of tool documentation, so the per-iteration LLM
// context is not filled with how-to instructions for tools the model has not
// decided to use yet:
//
//   Tier 1 (always on the wire): every contextual tool is sent to the model,
//   but MANUAL_TOOLS members get a SLIM definition — a short hand-written
//   routing description (TOOL_SUMMARIES) + their real schema with long
//   property prose truncated (enums/types/required stay intact; the `action`
//   enum description is kept in full because it is routing information).
//
//   Tier 2 (delivered on use): the FULL manual — the tool's original rich
//   description from TOOLS, plus the deep how-to KB text that used to live in
//   buildSystemPrompt (MANUAL_EXTRAS), plus a complete parameter reference
//   rendered from the original schema — is returned as the tool result of the
//   FIRST call to that tool in a turn. That first call does NOT execute; the
//   model reads the manual and re-issues the call, which then executes
//   normally for the rest of the turn.
//
// Security/behavior invariants this design preserves BY CONSTRUCTION:
//   - TOOLS stays the single source of truth; executors, TOOL_ROUTER,
//     getContextualTools, write-auth gates, backups and preflight checks are
//     untouched and see exactly the same calls as before.
//   - A write-capable tool can never execute before the model has been handed
//     its full instructions (the gate is deterministic, not best-effort).
//   - No instruction text is lost — it moves from "always in context" to
//     "in context from the moment the tool is first used".

// Write-capable / complex tools that use slim wire definitions + the
// first-call manual gate. Read tools (dhis2_query, search_metadata, counts,
// analytics, architect_metadata, …) and manage_backups (recovery path must be
// zero-friction) keep their full definitions on the wire.
const MANUAL_TOOLS = new Set([
  'create_metadata',
  'manage_metadata',
  'manage_program_rules',
  'manage_program_indicators',
  'manage_program_notifications',
  'manage_datasets',
  'manage_custom_forms',
  'manage_validation_rules',
  'manage_org_units',
  'manage_indicators',
  'manage_option_sets',
  'manage_legend_sets',
  'manage_dashboards',
  'manage_maps',
  'manage_line_lists',
  'manage_custom_translations',
  'manage_growth_chart_plugin',
]);

// Short routing descriptions sent on the wire for MANUAL_TOOLS. These carry
// WHAT the tool does and WHEN to pick it (including the safety-critical
// "never do this via dhis2_query" routing rules); HOW to call it lives in the
// manual.
const TOOL_SUMMARIES = {
  create_metadata: 'Create DHIS2 metadata: programs (with stages, data elements, inline option sets, program rules, program indicators — ALL in ONE atomic create_program call for small/medium programs; VERY LARGE programs (>2 stages / >40 DEs / >20 rules) are built incrementally: create_program with shell + first stage, then add_stage and add_program_rules in batches so each call fits the output limit), standalone option sets, standalone data elements (+ category combos for disaggregation), or add stages/DEs/rules to an existing program. Handles the full dependency chain and name→ID resolution, and REUSES existing TEAs/DEs/option sets by exact name (never pre-create them, never recreate an attribute that already exists); never pre-create a program\'s DEs/option sets with separate standalone calls.',
  manage_metadata: 'Metadata lifecycle manager: remove DEs from a stage, delete objects with reference checking, check_references, update a program\'s org-unit assignment, update sharing/access, add TEAs to an existing program, set icon/color (discover_icons FIRST, then update_style), convert value types (e.g. to MULTI_TEXT multi-select, cascaded). Use INSTEAD of dhis2_query for all of these — raw sharing/style/TEA/delete writes fail on DHIS2.',
  manage_program_rules: 'CRUD + audit for program rules, rule variables and rule actions on a program. Actions: list, get, create, update, delete, list_variables, audit, bulk_fix_conditions. For "broken / non-working rules" ALWAYS audit first, then bulk_fix_conditions. NEVER PUT/PATCH programRules via dhis2_query (409/415).',
  manage_program_indicators: 'CRUD + audit + cross-program discovery + OU ranking for tracker/event PROGRAM indicators. Actions: list, get, create, update, delete, audit, bulk_fix, bulk_fix_expressions, discover (cross-program "complex/top/heavy indicators", no program_id needed), rank_ou ("which OUs/districts have the most data/events"). NEVER PUT/PATCH programIndicators via dhis2_query; never invent UIDs.',
  manage_program_notifications: 'Program notification templates (webhook / email / SMS / dashboard message): list, get, create, update, delete, link, unlink, create_and_link (recommended one-shot: create + attach atomically with auto-rollback and dedup), orphan_sweep. Use INSTEAD of dhis2_query for any notification/webhook request — the payload shape and linking endpoint are non-obvious.',
  manage_datasets: 'Manage DHIS2 dataSets — the aggregate-data "programs" ("monthly form", "reporting form", "aggregate program" all mean a dataSet): list, get, create (atomic with DEs, sections, OUs, sharing), update, delete, add/remove data elements, assign_org_units, update_sharing, section CRUD. NEVER write dataset bodies via dhis2_query.',
  manage_custom_forms: 'Author CUSTOM (HTML) data-entry forms for a dataSet (pass dataset_id) or a tracker/event program STAGE (pass program_stage_id — the STAGE id, never the program id). Actions: get, preview_html (show generated HTML without saving), set_dataset_form, set_stage_form, remove_form. Omit html_code to auto-generate a clean table form from the target\'s data elements.',
  manage_custom_translations: 'Translate or re-label the UI strings of any DHIS2 app (2.43+ "custom-translations" datastore): list, get, set, remove. Keeps the controller registry in sync automatically — NEVER write those datastore keys via dhis2_query. Source strings must match the on-screen text exactly.',
  manage_growth_chart_plugin: 'Set up the WHO Capture Growth Chart plugin end-to-end: status (run first), install (from App Hub), scaffold_program (ready-made growth-monitoring tracker program), configure (auto-detects DOB/gender attributes + weight/height/head-circumference DEs and writes the plugin config), remove. NEVER hand-write its dataStore via dhis2_query.',
  manage_validation_rules: 'CRUD for DHIS2 validation rules — aggregate data-quality checks comparing a leftSide vs rightSide expression per period (e.g. "ANC 4 ≤ ANC 1"): list, get, create, update, delete. Both expressions are server-validated before saving. NEVER assemble validationRule /metadata bodies via dhis2_query.',
  manage_org_units: 'CRUD for organisation units (the facility/chiefdom/district hierarchy): list, get, create (needs name + opening_date, plus parent_id for every non-root; on a FRESH/EMPTY instance create the first root with NO parent_id), update (incl. MOVE/re-parent — level/path are DERIVED from the parent, never set them), delete (leaf-only, reference-safe). NEVER hand-write org-unit /metadata bodies via dhis2_query.',
  manage_indicators: 'CRUD for AGGREGATE indicators — (numerator ÷ denominator) × factor values shown on dashboards/pivots/maps: list, get, create, update, delete. Tracker/event PROGRAM indicators are a DIFFERENT object → manage_program_indicators. Expressions are server-validated before save; chain legend_set_id to render colour-coded. NEVER write indicator bodies via dhis2_query.',
  manage_option_sets: 'Standalone option-set lifecycle (reusable ordered code/label drop-downs): list, get, create, update (own fields), add_options, remove_options, reorder_options, delete. For an option set inline on a NEW data element use create_metadata instead; to convert a set to MULTI_TEXT use manage_metadata(action=convert_value_type). NEVER hand-write option bodies via dhis2_query.',
  manage_legend_sets: 'Standalone legend-set lifecycle (reusable colour bands for traffic-light / heat-map rendering): list, get, create (explicit legends or auto_bands red→amber→green), add_legends, remove_legends, update (own fields), delete. Attach to an aggregate indicator via manage_indicators(legend_set_id) — never via raw PATCH. NEVER hand-write legendSets bodies via dhis2_query.',
  manage_dashboards: 'Build/inspect analytics dashboards and saved visualizations (charts, pivots, single-value tiles): list, get, create_visualization, create_dashboard (atomic, with inline new visualizations), add_items (the ONLY safe way to add to an EXISTING dashboard — a raw PUT wipes its tiles), remove_item, update, delete. NEVER hand-assemble visualizations/dashboards bodies via dhis2_query (they import as EMPTY charts). render_chart = inline chat preview; this tool SAVES to DHIS2.',
  manage_maps: 'Create/inspect/delete thematic maps (choropleth / bubble): list, get, create (one data_item UID + org_unit_level/org_units + period, optional legend_set_id), delete. NEVER hand-assemble /api/maps bodies via dhis2_query. Place a map on a dashboard via manage_dashboards(action=add_items, items=[{type:"MAP", map_id}]).',
  manage_line_lists: 'Author SAVED line lists — the row-per-record tables of the Line Listing app (eventVisualizations type LINE_LIST): list, get, create (EVENT / ENROLLMENT with cross-stage + repeated-event columns / TRACKED_ENTITY; dimensions by UID or exact name, auto stage/option-code resolution, filters, sorting, legend; the layout is PROVEN against analytics BEFORE saving), update, delete, validate (re-run its query → row_count). NEVER hand-assemble eventVisualizations bodies via dhis2_query (the app cannot open them). Dashboard placement: manage_dashboards items [{type:"EVENT_VISUALIZATION", event_visualization_id}]. line_listing_guide = app UI help; THIS tool saves the actual line lists.',
};

// ── Deep how-to KB text that used to live in buildSystemPrompt ──
// Delivered inside the relevant tool manual(s) on first use instead of being
// injected into every turn's system prompt. Shared blocks are defined once.

const KB_PROGRAM_RULE_SYNTAX = `**Program Rule syntax:**
- Condition: \`#{variable_name}\` for DEs (lowercase, underscores), \`A{attr_name}\` for TEAs, \`V{current_date}\` for system vars
- ⚠ **\`A{attr_name}\` IS the correct, canonical way to reference a tracked-entity-attribute program rule variable** in BOTH conditions and ASSIGN/expression \`data\` — this matches DHIS2's own demo rules, e.g. \`d2:yearsBetween(A{born}, V{current_date})\` and \`A{Sex} == 'MALE'\`. \`#{...}\` is for DATA-ELEMENT-sourced variables only. **Do NOT "fix" a working \`A{tea}\` reference into \`#{tea}\`** — for a TEA variable that is a regression, not a fix, and it is NEVER the cause of a rule "not firing". Auto-calc-from-attribute patterns like \`ASSIGN d2:monthsBetween(A{dob}, V{current_date}) → "Age in months"\` are correct as written.
- 🔎 **When a user says an auto-assign / calculation rule "isn't working", DIAGNOSE from real metadata — never guess a syntax cause.** First \`manage_program_rules(action=get)\` + \`action=list_variables\` and read the ACTUAL condition, the PRV source types, and the target DE's valueType. If the expression already matches a known-good pattern (A{tea} for attributes, V{current_date}, a valid d2: function, ASSIGN target DE that can hold the result), the rule is correct — say so. The real reasons an ASSIGN value looks "missing" are runtime/UX, not syntax: (a) the assigned value only appears once you open the stage event that contains the target DE and the source attribute already has a value; (b) the target field is read-only/auto-filled by design; (c) the target DE valueType cannot hold the computed value (e.g. a number assigned to a TEXT field). Explain the real cause and verify; do NOT invent "the reference doesn't resolve at runtime" without evidence.
- HIDEFIELD on TEA: use \`tracked_entity_attribute_name\`; on DE: use \`data_element_name\`
- Action types: SHOWWARNING, SHOWERROR, HIDEFIELD, HIDEPROGRAMSTAGE, HIDESECTION, HIDEALLFIELDS, ASSIGN, SETMANDATORYFIELD, DISPLAYTEXT, DISPLAYKEYVALUEPAIR, WARNINGONCOMPLETE, ERRORONCOMPLETE (⚠ SHOWWARNINGINFORMATION is NOT accepted by the server enum — it is auto-aliased to SHOWWARNING)
- Actions fire when the condition is TRUE. "Hide X unless Y=Yes" → write the HIDE condition as "Y is not Yes", not "Y is Yes".
- ⛔ **There is NO "show field" action — visibility is ONE hide rule, never a show/hide pair.** Fields, sections and stages are visible by default; a HIDE action hides while its condition is TRUE and the engine re-shows AUTOMATICALLY the moment it turns false. Therefore "show X only when Y is Yes" = EXACTLY ONE rule: \`{ name: "Hide X when Y is not Yes", condition: "!d2:hasValue(#{y}) || #{y} != true", actions: [{ type: "HIDEFIELD", data_element_name: "X" }] }\`. NEVER ALSO create a second "Show X when Y is Yes" rule — a complementary twin hides the target in EVERY case (permanently hidden). NEVER put a HIDE action under the positive/"show" condition. NEVER combine HIDEFIELD and SETMANDATORYFIELD on the same field in one rule (hidden-AND-mandatory renders the field broken/un-selectable in Capture — this is exactly what breaks multi-select option sets). If X must be required when visible, that is a SEPARATE rule: \`{ name: "Require X when Y is Yes", condition: "#{y} == true", actions: [{ type: "SETMANDATORYFIELD", data_element_name: "X" }] }\`. The tool hard-refuses all three broken shapes (phase "lint") — emit the one-rule pattern from the start.
- 🔎 **"Field shows but can't be used / options not selectable / field never appears" → run \`action=audit\` FIRST.** Its \`cross_rule_issues\` detects hide+mandate contradictions and complementary show/hide twins on existing programs. NEVER blame "a DHIS2 rendering issue" without audit evidence — these symptoms are almost always contradictory program rules.
- **SHOWWARNING / SHOWERROR / WARNINGONCOMPLETE / ERRORONCOMPLETE** display \`content\` (static prefix) **plus** the *evaluated* \`data\` expression. Variables like \`#{var}\` or \`A{attr}\` placed in \`content\` are shown LITERALLY (the user sees the brace token, not the value). To echo a field value, set \`content: "Selected risks:"\` and \`data: "#{maternal_risk_factors}"\`. For multiple variables use \`d2:concatenate("prefix ", #{a}, ", ", #{b}, " suffix")\` in \`data\`. The tool auto-rewrites trailing variables out of content into data, but emit the right shape from the start.
- **DISPLAYTEXT** (instructions banner) takes \`content\` only — keep it static.
- **DISPLAYKEYVALUEPAIR** shows a live value in the Feedback (default) or Indicators widget: \`content\` = the static label/key, \`data\` = the evaluated expression (e.g. \`{ type: "DISPLAYKEYVALUEPAIR", content: "BMI", data: "#{weight_kg} / ((#{height_cm}/100) * (#{height_cm}/100))" }\`). This is THE action for "display X in the Feedback widget" requests; add \`location: "indicators"\` to target the Indicators widget instead.
- **ASSIGN** uses \`data\` exclusively (a d2 expression assigned to the target DE/TEA); content is ignored.
- **HIDEALLFIELDS** (chatbot sugar — not a raw DHIS2 type): pass it as \`{ type: "HIDEALLFIELDS", exclude_data_element_ids: [<trigger DE id>] }\` and the tool auto-expands it into one HIDEFIELD per DE in the trigger's stage (excluding excluded IDs) plus one HIDEPROGRAMSTAGE for every other stage in the program. Use this whenever the user says "hide all data elements", "hide everything except X", "gate the form on X" — single-stage HIDEFIELD enumeration silently misses other stages.
- **DHIS2 capture compulsion gotcha** (auto-handled by HIDEALLFIELDS): a HIDEFIELD action targeting a *compulsory* PSDE leaves the field VISIBLE in New Tracker Capture — compulsion outranks visibility. HIDEALLFIELDS automatically (a) PUTs the affected program stage(s) with \`compulsory: false\` on every hidden PSDE, AND (b) auto-creates a paired SETMANDATORYFIELD rule with the inverse condition so the original "required when visible" semantic is preserved. Pass \`restore_mandate_when_visible: false\` on the HIDEALLFIELDS action to skip the paired rule. The summary lists \`compulsory_flags_cleared\` and \`auto_paired_mandate_rules\` so you can report what changed. NEVER manually emit HIDEFIELD per-DE for "hide all" requests — you'll silently leave the compulsory ones visible.
- **HIDEPROGRAMSTAGE** (better than N HIDEFIELDs when no DE in that stage is the trigger); HIDESECTION hides a section. Two things you MUST know (verified live on Capture 2.40):
  • **Stage reference:** on create_program pass \`program_stage_name: "<stage name from THIS call>"\` — stage IDs are generated during the call, so an id-less action bounces the whole atomic import with "ProgramStage cannot be null". On an existing program either program_stage_id or program_stage_name works.
  • **What the user actually sees in the NEW Capture web app:** the stage card stays VISIBLE on the enrollment dashboard — HIDEPROGRAMSTAGE only disables adding new events to it (the "+ New <stage> event" button greys out with "You can't add any more … events"). Only the legacy Tracker Capture app and the Android app hide the stage tab entirely. When you create such a rule, TELL THE USER this so they don't report it as broken.
- **\`V{event_date}\` is EMPTY until the user fills the event's Report date.** In a fresh Capture form the report-date field starts blank, so an ASSIGN like gestational age \`d2:weeksBetween(#{lmp}, V{event_date})\` shows nothing until the report date is entered — then it fills instantly (verified live: EDD = d2:addDays fills immediately, GA fills on report-date entry). This is normal engine behavior, NOT a broken rule; proactively tell the user "the calculated value appears once the event/report date is set". Use V{current_date} instead ONLY if the value must appear before any date is entered and "as of today" semantics are acceptable.
- **Numeric \`<\` / \`<=\` comparisons fire on EMPTY fields** — the engine coerces an empty numeric field to 0, so \`#{apgar} < 7\` shows its warning on a blank form. The tool auto-wraps bare \`#{x} < n\` atoms as \`(d2:hasValue(#{x}) && #{x} < n)\` (reported as auto_guarded_conditions); write the d2:hasValue guard yourself in anything more complex (negations are never auto-touched).
- BOOLEAN / TRUE_ONLY: compare against unquoted \`true\` / \`false\`. Canonical forms:
  • is Yes: \`#{flag} == true\`
  • is empty or No: \`!d2:hasValue(#{flag}) || #{flag} != true\`
  ⚠ Never write \`#{flag} == false\`, \`== 'true'\`, \`== 'Yes'\`, or \`== 'No'\` — these fail silently on DHIS2.
- Option-set fields: compare to the option CODE in quotes, e.g. \`#{status} == 'APPROVED'\`. All auto-created PRVs for option-set DEs/TEAs get \`useCodeForOptionSet: true\` (a false value makes #{var} yield the option NAME so \`== 'CODE'\` never matches — a silent, rule-never-fires failure). Auto-generated codes are UPPER_SNAKE of the option name ("Live Birth" → \`LIVE_BIRTH\`). The tool also auto-maps option-NAME literals in conditions/ASSIGN data to their codes (condition_option_rewrites in the result) and flags literals matching neither name nor code (condition_option_advisories) — read those advisories, they mean the rule will never fire as written.
- ⚠ **Every \`#{name}\` MUST resolve to a programRuleVariable for the rule to fire.** For \`manage_program_rules(action=create)\` on an existing program: just use \`#{sanitized_de_display_name}\` (e.g. DE "Is breathing abnormal" → \`#{is_breathing_abnormal}\`) — the tool auto-creates the PRV by matching the sanitized name to the program's DEs and picks the correct sourceType (CURRENT_EVENT when the rule acts on the same stage, NEWEST_EVENT_PROGRAM otherwise) plus valueType + optionSet from the DE. Pass \`variables:[]\` only if you need to override the source_type, reference a DE whose displayName does not match, or wire a TEI_ATTRIBUTE variable. If a \`#{name}\` does not match any existing PRV or program DE, the tool refuses the POST and returns \`unresolved[]\` with suggestions — correct the name or add an explicit \`variables[]\` entry and retry. Display-name tokens (e.g. \`A{Date of Birth}\`, \`#{Danger Signs}\`) are auto-sanitized and rewritten to canonical form (\`A{date_of_birth}\`) — reported as \`rule_token_rewrites\` — but emit the sanitized form from the start.`;

const KB_PI_GRAMMAR = `### Program-Indicator EXPRESSION GRAMMAR (DHIS2 2.41) — read this BEFORE writing any PI
The PI grammar is **NOT** the program-rule grammar. They share \`#{}\` and \`d2:\` syntax but have DIFFERENT function sets and different semantics. The chatbot lints every PI expression+filter both locally and via DHIS2's /expression/description endpoint before saving — broken PIs are rejected at create-time, not silently saved.

**Refs (in expression OR filter):** \`#{stageId.deId}\` (data element in a stage), \`A{teaId}\` (tracked-entity attribute), \`V{var}\` (system variable: \`tei_count\`, \`event_count\`, \`enrollment_count\`, \`event_date\`, \`enrollment_date\`, \`enrollment_status\`, \`current_date\`, etc.), \`C{constantId}\` (constant). **Do NOT** use \`I{}\` (regular indicator), \`OUG{}\`, or \`subExpression(...)\` — those are for regular Indicators, not Program Indicators, and the parser rejects them.

**Operators:** \`== != < > <= >=\` (==/= behave the same way — **exact-string match** for strings, even on MULTI_TEXT), \`&& ||\`, \`+ - * /\`. There is **NO** \`LIKE\`, \`ILIKE\`, \`IN\`, \`position()\`, \`regexp_match()\`, \`coalesce()\`, or \`~\` regex in PI grammar. The parser will say "Invalid string token 'LIKE'" or similar.

**Allowed d2: functions in PI (parser-verified live on 2.42 + 2.43 — the docs list MORE, but the parser rejects them):** \`condition\`, \`count\`, \`countIfValue\`, \`countIfCondition\`, \`hasValue\` (**FILTER only** — the expression parser rejects it), \`daysBetween\`, \`weeksBetween\`, \`monthsBetween\`, \`yearsBetween\`, \`minutesBetween\`, \`minValue\`, \`maxValue\`, \`oizp\`, \`zing\`, \`zpvc\`, \`relationshipCount\`.

**Documented-but-REJECTED by the PI parser** ("Item d2:<fn>( not supported for this type of expression", verified 2.42/2.43): \`ceil\`, \`floor\`, \`round\`, \`modulus\`, \`addDays\`, \`left\`, \`right\`, \`substring\`, \`split\`, \`concatenate\`, \`length\`, \`validatePattern\`, \`inOrgUnitGroup\`, \`lastEventDate\`, \`zScoreHFA\`/\`WFA\`/\`WFH\`. For rounding, keep plain arithmetic and set the indicator's \`decimals\` (e.g. gestational weeks = \`d2:daysBetween(#{stage.lmp}, V{event_date}) / 7\` with \`decimals: 0\`). For org-unit scoping use the visualization's ou dimension, never the PI.

**FORBIDDEN d2: functions in PI** (these exist only in Program Rules — using them in a PI filter creates a PI that **looks** saved but returns HTTP 409 from analytics forever after): \`d2:contains\`, \`d2:containsString\`, \`d2:inOrgUnit\`, \`d2:hasUserRole\`, \`d2:removeMin\`.

**Quoting inside d2:condition:** the first arg is a STRING. To embed a string literal you need different outer-quotes — use **double-quoted outer**: \`d2:condition("#{stage.de} == 'X'", 1, 0) == 1\`. Single-quoted outer with escaped inner does NOT parse.

**MULTI_TEXT (multi-select) — read carefully:**
- DHIS2 stores MULTI_TEXT as a single comma-separated string per row (e.g. \`Diabetes,HYPERTENSION\`).
- In PI filters, \`==\` does **exact-string match** even on MULTI_TEXT — verified: a row stored as \`Diabetes,HYPERTENSION\` matches \`#{X.Y} == 'Diabetes,HYPERTENSION'\` but NOT \`#{X.Y} == 'Diabetes'\`. Order is whatever the user clicked first.
- **There is NO native way to express "MULTI_TEXT contains both X and Y" in a 2.41 PI filter.** \`d2:contains\` is rule-engine-only. \`subExpression\` is not available for PIs in 2.41.
- When the user asks for "women with both Diabetes and Hypertension" on a MULTI_TEXT field, recommend ONE of these THREE options up front and let the user choose:
  1. **Restructure (best, durable):** convert the MULTI_TEXT into N separate BOOLEAN data elements (one per option), via \`create_metadata\` for new programs or by adding new BOOLEAN DEs and a program rule that mirrors the multi-select. Filter is then trivial: \`#{stage.de_dm} == true && #{stage.de_htn} == true\`.
  2. **Line Listing app (no metadata change):** the Line Listing UI supports the IN operator with comma-list values which DOES match comma-separated MULTI_TEXT cells. Use \`line_listing_guide\` to walk the user through it.
  3. **Brittle exact-match (stopgap):** \`#{stage.de} == 'Diabetes,HYPERTENSION'\` — only matches that exact string, order-dependent, breaks if a third risk factor was also selected. Disclose the limitation.
- **NEVER** silently emit \`d2:contains(...)\` or \`#{X.Y} == 'A' && #{X.Y} == 'B'\` for the same ref — the lint blocks both.

**aggregationType vs analyticsType:**
- \`analyticsType\`: \`EVENT\` (one row per event) or \`ENROLLMENT\` (one row per enrollment, latest event values per stage).
- \`aggregationType\`: \`COUNT\` for count-of-rows, \`SUM\`/\`AVERAGE\`/\`MIN\`/\`MAX\` for numeric aggregations.
- "Count of women with X" → \`analyticsType=ENROLLMENT, aggregationType=COUNT, expression=V{tei_count}\`. \`V{enrollment_count}\` is also valid; \`V{event_count}\` is for EVENT-type PIs.

**PERCENTAGE / COVERAGE = ONE program indicator (NOT three).** A metric like "% of pregnant women whose first ANC was before 12 weeks" is **a SINGLE program indicator**, not a numerator PI + a denominator PI + a percentage object. Build it as:
- \`analytics_type: "ENROLLMENT"\` (count each woman/pregnancy once, not once per visit),
- \`filter\`: the **DENOMINATOR** population — who is eligible (e.g. \`#{FIPs4MVhcok.gestAge} < 999\` = women with a valid gestational age),
- \`expression\`: \`d2:condition("<NUMERATOR condition>", 100, 0)\` — 100 when the woman meets the numerator, else 0 (e.g. \`d2:condition("#{FIPs4MVhcok.gestAge} < 12", 100, 0)\`),
- \`aggregation_type: "AVERAGE"\` — the mean of a 0/100 flag over the denominator population **is** the percentage,
- \`decimals: 1\`. Verified live on 2.42/2.43 — the description endpoints accept it and it plots directly on line charts/maps/single-value cards.
This is the pattern to use whenever the user asks for "the percentage/rate/coverage of …". It contains **no division**, so unlike a numerator/denominator ratio it never 409s on a zero denominator. Do NOT reflexively create separate numerator + denominator count PIs — create them **only** when the user explicitly wants those counts as their own tiles or as separate columns of a table (e.g. "a table showing numerator, denominator, percentage"). In that case: one COUNT PI for the numerator, one COUNT PI for the denominator, and the single AVERAGE percentage PI above — all in ONE batch.

**BATCH every multi-indicator build.** \`manage_program_indicators(action="create", program_id, indicators:[ {…}, {…}, … ])\` validates and commits them all in a SINGLE metadata import and returns \`program_indicator_ids\` (a flat UID list) to chain into visualizations/maps/dashboard \`data_items\`. A coverage dashboard needs 10-40 indicators; creating them one-per-call exhausts the agentic-loop budget before any chart or dashboard is built (the pregnancy-analytics failure). Plan the full indicator set, then create it in one (or a few) batched calls. Invalid entries are skipped and returned under \`failed[]\` — fix just those and re-batch the remainder; the valid ones are already saved.

**Indicators widget during data entry:** when the user wants an indicator visible in the right-side "Indicators" widget of Tracker Capture / Capture (e.g. live gestational age, risk flags), pass \`display_in_form: true\` in the indicator object (create or update). Per-event calculations (EVENT analytics) read most naturally there.

**Validation safety net (you don't manage this — it just runs):**
- Every \`manage_program_indicators(action=create|update)\` call validates expression+filter via DHIS2's \`/programIndicators/expression/description\` and \`/filter/description\` endpoints BEFORE saving. If either returns \`status: ERROR\`, the create/update is refused and the parser's exact error string is returned to you in \`_error\` along with a hint in \`_hint\`. Read both, fix the expression, and retry — do NOT loop with the same broken filter.`;

const KB_VALUE_TYPE_MAPPING = `**Value-type mapping** (use these exact DHIS2 valueTypes):
- "Yes/No" / "boolean" → \`BOOLEAN\`
- "Yes only" / "checkbox" → \`TRUE_ONLY\`
- "date" → \`DATE\`
- "date and time" → \`DATETIME\`
- "number" → \`NUMBER\`, integer → \`INTEGER\`, positive integer → \`INTEGER_POSITIVE\`
- "text" → \`TEXT\`, long text → \`LONG_TEXT\`
- "option set / dropdown / select from list" (single-select) → \`TEXT\` with an inline \`option_set: { name, options: [...] }\`
- "multi-select / multiple values / multiple selections / multi-select option set / text with multiple values / select multiple" → \`MULTI_TEXT\` with an inline \`option_set: { name, options: [...] }\`. The tool auto-aligns the option set's own valueType to \`MULTI_TEXT\` so the pair is consistent — never declare a multi-select DE with \`TEXT\`, even though the field stores comma-separated codes at runtime; the New Tracker Capture form only renders the multi-checkbox UI when the DE valueType is \`MULTI_TEXT\`. To **convert** an existing TEXT option set + DE into multi-select, use \`manage_metadata(action=convert_value_type, object_type="dataElements"|"optionSets", object_id=..., value_type="MULTI_TEXT")\` — it cascades the change to every DE/TEA referencing the option set.`;

const KB_CREATE_PROGRAM_DETAILS = `### create_program — the ONE-CALL pattern in detail
The tool handles the FULL dependency chain atomically and auto-resolves all internal references (option set names → IDs, DE names → IDs, TEA names → IDs). It also auto-checks for duplicate option sets, data elements, TEAs, and options by name and reuses existing IDs.

**Input slots for the single create_program call:**
- \`tracked_entity_type_id\` (WITH_REGISTRATION programs only): NEVER hardcode/guess a UID here. Either omit it (defaults to the TrackedEntityType named "Person") or pass the exact TrackedEntityType NAME (e.g. "Person", "Household") — the tool resolves the name to its real UID for you. If unsure such a type exists, check first with architect_metadata(action="check_existing", object_type="trackedEntityTypes").
- \`program_attributes\`: tracked entity attributes (with inline \`option_set\` if needed). **Existing attributes are REUSED, never recreated:** common TEAs (First/Full name, Date of birth/DoB, Sex, National ID, phone number, address, …) almost always already exist on the instance. Just list them by name — if the EXACT name exists the tool attaches the existing TEA instead of creating a duplicate; you can also pin one explicitly with \`id: "<UID>"\`. If the server ever answers "already exists on object <UID>", that UID IS the attribute to reuse (pass it as \`id\`) — NEVER dodge the error by renaming ("Full name 2", "Sex (new)"): that pollutes the instance with near-duplicates.
- \`org_unit_ids\`: the org units the program should be assigned to for Capture/Tracker use. If the user mentions districts/facilities/org units, resolve them first and pass them here.
- \`assign_all_org_units: true\`: use this WHEN THE USER SAYS "all OUs", "all org units", "all levels", "all facilities", "every org unit" — the tool fetches every org unit server-side in ONE call. DO NOT paginate org units yourself.
- \`sharing\`: \`{ public_access: "rwrw----", include_current_user: true, user_ids: [...], user_group_ids: [...] }\`. Set \`include_current_user: true\` when the user says "include me", "share with me", "I should have access", etc. Sharing is auto-applied to stages + DEs + option sets + TEAs unless \`apply_to_children: false\`. **DHIS2 only permits data-level sharing (positions 3-4 of the access string) on Program + ProgramStage — DataElement, OptionSet, TrackedEntityAttribute, ProgramIndicator are metadata-only.** The tool strips the data bits automatically for those classes, so a single \`public_access: "rwrw----"\` is safe everywhere.
- \`stages\`: data elements (with inline \`option_set\` if needed)
- \`program_rules\`: rules with \`#{sanitized_name}\` conditions and actions (\`data_element_name\` or \`tracked_entity_attribute_name\`). Stage-targeting actions (HIDEPROGRAMSTAGE, CREATEEVENT) MUST reference the stage by \`program_stage_name\` (a stage name from this same call) — stage IDs do not exist yet. ⛔ Visibility = ONE hide rule per target: there is NO SHOW action (fields re-appear automatically when the hide condition turns false), so NEVER emit show/hide rule pairs, never hide under the positive/"show" condition, and never combine HIDEFIELD + SETMANDATORYFIELD on the same field in one rule — all three shapes are refused at lint time. ⚠ **Every \`A{}\`/\`#{}\` in a rule MUST name an attribute/data element you ALSO define in this same call** (e.g. a rule using \`A{date_of_birth}\` requires a \`program_attributes\` entry named "Date of Birth"). An individual rule that references an unresolvable variable/stage/section is now **SKIPPED** — the program and everything else still import — and reported back under \`_skipped_rules\` with a \`_next_step\`. When you see \`_skipped_rules\`: do NOT re-run create_program; report the created program to the user AND add each skipped rule with \`manage_program_rules(action=create, program_id=...)\` referencing a real variable (or tell the user which attribute is missing).
- \`program_indicators\`: indicators with expressions and filters

**Internal dependency order** the tool enforces in the atomic payload (you never build this yourself — it's here so you understand recovery):
Options → OptionSets → TrackedEntityAttributes → DataElements → Program + ProgramStages (stages carry programStageDataElements) → ProgramRuleVariables → ProgramRuleActions → ProgramRules → (follow-up POST) ProgramIndicators. Sharing attaches to Program/Stage in full; DE/OS/TEA/PI get metadata-only. OrgUnit assignment rides inside the Program object.

**\`success: true\` with \`_skipped_rules\`** = the program WAS created but some rules could not be built (unresolvable variable/stage/section). This is NOT a failure and NOT a reason to retry create_program — the returned \`program_id\`/\`stage_ids\` are real. Follow \`_next_step\`: add each skipped rule via \`manage_program_rules\`, then summarize for the user what exists and what still needs the missing reference.

**If create_program returns \`success: false\`, read \`errors[]\` — and remember the import is ATOMIC: NOTHING was created.** Never call add_program_rules / add_stage / manage_custom_forms with IDs from a failed attempt (they don't exist — you'll get a 404); fix the input and re-issue the whole create_program. Do NOT re-send a byte-identical create_program call after a failure — an exact repeat is refused, and after repeated identical failures the tool is disabled for the rest of the turn; change the failing input or stop and report.
- "Data sharing is not enabled for X" → the tool now strips data bits itself; if you still see this, a custom class changed — retry with \`sharing.apply_to_children: false\` and then run \`manage_metadata(action=update_sharing)\` per object.
- "Property X is required" on a specific klass → add that field to the matching input slot and retry the WHOLE create_program (the rollback is atomic).
- Validation rejects ONE stage (name clash, bad DE) → keep the other stage in a retry minus the bad one, then use \`add_stage\` / \`add_data_elements_to_stage\` afterwards to fix the rejected piece.
- "already exists on object <UID>" (TEA / DE / option set) → the tool auto-reuses the existing object and retries by itself; if the error still surfaces, re-issue passing that existing <UID> (\`id\` for program_attributes) or the exact existing name — NEVER a renamed variant.
Never retry by looping through children one-at-a-time when the single atomic retry can succeed. Decompose only on targeted rejection.

### Category combos / disaggregation (create_category_combo, create_data_elements)
**NEVER assemble raw /metadata POST payloads for category combos** — DHIS2 silently 409s on dependency-order mistakes (categoryOptions before categories before combos), missing \`dataDimensionType\`, or forgotten CoC regeneration. Instead:

\`\`\`
create_metadata(action="create_category_combo", category_combo:{
  name: "HTS Result by Sex",
  data_dimension_type: "DISAGGREGATION",   // or ATTRIBUTE
  categories: [
    { name: "HIV Result", options: ["Positive", "Negative"] },  // NEW — auto-creates options
    { id: "cX5k9anHEHd" }                                        // EXISTING — reuse by id
  ]
}, sharing:{ public_access: "--------", user_group_ids: ["<gid>"], user_group_access: "rw------" })
\`\`\`

What the tool does for you (you DON'T do these by hand): reuses existing categories/options by exact name (no duplicates), POSTs categoryOptions + categories + categoryCombo in ONE atomic /metadata call in the correct dependency order, ALWAYS triggers \`/api/maintenance/categoryOptionComboUpdate\` so the CoC rows materialize (without this the form has no cells and Save silently drops values), and applies sharing via the legacy \`/api/sharing\` endpoint (the only path that works for metadata-only-shareable classes).

Creating data elements that USE a (new or existing) combo — ONE atomic call:
\`\`\`
create_metadata(action="create_data_elements",
  domain_type: "AGGREGATE",                  // or TRACKER (default)
  aggregation_type: "SUM",
  category_combo: { ...inline definition as above... },   // OR category_combo_id / category_combo_name
  data_elements: [
    { name: "Individuals Tested for HIV", value_type: "INTEGER", use_category_combo: true },
    { name: "Referrals to Care Made",     value_type: "INTEGER", use_default_combo: true }   // no disagg
  ])
\`\`\`
\`use_category_combo: true\` binds that DE to the inline/named combo; \`use_default_combo: true\` keeps it on the system default. DEs with neither flag inherit from the call's category_combo (or default if none). Attach an option set either inline (\`option_set\` — creates a new set) or by reference (\`option_set_id\` / \`option_set_name\` — reuses an existing set; the DE valueType auto-aligns). Mix freely in one call.

### Adding to existing programs
- DEs to an existing stage: create_metadata(action=add_data_elements_to_stage, stage_id=<id>, data_element_ids=[<id>]) — use \`data_elements:[{name, value_type, …}]\` instead to create NEW DEs onto the stage. This action ALWAYS backs the stage up first and preserves the stage's existing sections + form type. If the stage uses a SECTION form with multiple sections, ALSO pass \`section_name\` (the section the new field belongs under) — without it the tool stops and lists the sections rather than guessing. Never revert a sectioned stage to a default form to add a field.
- A new stage: create_metadata(action=add_stage, program_id=<id>, stage={ name, repeatable, data_elements:[…] }).
- More rules: create_metadata(action=add_program_rules, program_id=<id>, program_rules=[…]).

### ⚠ VERY LARGE programs — split the build so each tool call fits your output budget
A tool call's arguments must fully fit inside ONE model response. A whole 4–5 stage program with 80–100 data elements, dozens of option sets, and 40+ rules in a single create_program call easily exceeds a typical max-output limit — the streamed JSON gets cut off mid-payload, NOTHING is created, and you are asked to resend. Do not gamble on it: **when a program has more than ~2 stages or ~40 total data elements or ~20 rules, build incrementally from the start:**
1. \`create_metadata(action=create_program)\` — program shell, ALL program_attributes, and ONLY the first stage with its data_elements/sections. Include NO program_rules yet.
2. \`create_metadata(action=add_stage, program_id=<id from step 1>, stage={…})\` — one call per remaining stage.
3. \`create_metadata(action=add_program_rules, program_id=<id>, program_rules=[10–15 rules])\` — repeat until all rules are added. Rules are the wordiest part; never send more than ~15 per call.
Each call is atomic, reuses existing metadata by name exactly like the one-call form, and the earlier calls' results give you the real stage/DE ids for later ones. A small/medium program (1–2 stages, ≤40 DEs, ≤20 rules) should still use the classic ONE create_program call.`;

const KB_METADATA_DELETE_FLOW = `### Removing / deleting metadata
⚠️ **NEVER** use dhis2_query with DELETE method for metadata objects. manage_metadata checks references and verifies deletion.
**Workflow to remove a data element from a program and delete it:**
1. \`manage_metadata(action=remove_from_stage, stage_id=<stageId>, data_element_ids=[<deId>])\` — removes DE from the stage (keeps DE in system)
2. \`manage_metadata(action=delete, object_type=dataElements, object_id=<deId>)\` — deletes the DE after checking references
**If deletion fails (409 / references exist):** the tool returns exactly which references block deletion (program stages, program rules, event data). Remove those references first, then retry.
**Supported object types for delete:** dataElements, optionSets, options, trackedEntityAttributes, programStages, categoryOptions, categories, categoryCombos, indicators, dataElementGroups, indicatorGroups (plus programs, dataSets, dashboards, visualizations, maps for whole-object deletes).

**Convert a single-select option set to multi-select (or any valueType change):**
- \`manage_metadata(action=convert_value_type, object_type="dataElements", object_id="<deId>", value_type="MULTI_TEXT")\` — flips the DE valueType AND its attached optionSet AND every other DE/TEA referencing the same optionSet (so the pair is never inconsistent). Works on \`dataElements\`, \`trackedEntityAttributes\`, or \`optionSets\` directly. Idempotent — already-correct objects are skipped.
- ⛔ **NEVER** PATCH only the DE's valueType to MULTI_TEXT and leave the optionSet at TEXT — the New Tracker Capture form will silently render single-select.`;

const KB_METADATA_TEA_OU = `### Adding tracked-entity attributes to an EXISTING program
\`manage_metadata(action=add_program_attributes, program_id="<id>", program_attributes=[
  { name: "First name", searchable: true, display_in_list: true },
  { name: "Age",        searchable: true, display_in_list: true }
])\`
- Each entry may supply \`id\` (reuse a known TEA), \`name\` alone (reuses one by that exact display name, or creates new if \`value_type\` is provided), or \`name + value_type [+ option_set]\` (creates fresh).
- ⛔ **NEVER** try to PATCH \`programs/{id}\`, POST \`programTrackedEntityAttributes\`, or POST \`/metadata\` to attach TEAs — those routes return 415/404/409. Always use this action.

### Updating which OUs a program is assigned to
\`manage_metadata(action=update_program_org_units, program_id="<id>", org_unit_ids=["<ou1>","<ou2>"], merge_mode="replace")\`
- \`replace\` = exact OU list; \`add\` = append; \`remove\` = remove from existing assignment.
- OU assignment and sharing are SEPARATE: a program can have broad sharing but still be unusable at a facility that is not in \`program.organisationUnits\`.`;

const KB_METADATA_ICON_FLOW = `### Icon / style updates — discover FIRST, then update_style
DHIS2 ships a fixed library of ~900 icons. Many obvious-sounding names DO NOT EXIST: \`tuberculosis_positive\`, \`diabetes_positive\`, \`vaccine_positive\`, \`pregnancy_positive\` are all fabrications. Guessing burns tool round trips.
**MANDATORY two-step flow — never skip step 1:**
1. **Discover** — \`manage_metadata(action=discover_icons, keywords=["<root1>","<root2>",...])\`
   - Pass 4-8 SHORT keyword roots, not full domain words. DHIS2 search is prefix-on-keyword: \`preg\` matches but \`pregnancy\` returns 0; \`respir\` matches but \`respiratory\` returns 0; \`tb\` works, \`tuberculosis\` doesn't.
   - For a TB program: \`["lung","respir","tb","medical","clinic"]\`. For maternity: \`["preg","mater","baby","fem"]\`. For vaccines: \`["vacc","syring","needle","shield"]\`.
   - The response gives you \`verified_keys[]\` — every real key that matched any of your roots.
2. **Apply** — \`manage_metadata(action=update_style, object_type=..., object_id=..., icon=<exact key from verified_keys[]>, color="#...")\`
   - Pass the icon key VERBATIM from step 1's response. \`update_style\` REFUSES any icon that wasn't verified this turn (\`_scope: "icon_not_verified"\`). \`color\` (optional hex) does not require discovery.
**If discover_icons returns no matches**, retry with broader fallbacks: \`["medical","clinic","health","hospital","stethoscope","capsule"]\`. If still nothing, drop the icon and set only \`color\`.
**Do NOT** PATCH \`/programs/{id}\` with dhis2_query using \`application/json\` — DHIS2 returns 415. update_style uses \`application/json-patch+json\`, verifies the result, and snapshots a backup first.`;

const KB_METADATA_SHARING = `### Sharing & Access (update_sharing)
When a program/object doesn't appear in an app (Capture, Data Entry, etc.) or a user reports "can't see" / "not showing":
**Diagnosis:**
1. For programs in Capture/Tracker, first check \`program.organisationUnits\` — if the target OU is missing, fix that with \`manage_metadata(action=update_program_org_units, ...)\`
2. Fetch the object with \`?fields=id,displayName,sharing,access\` — check \`access.data.read\` and \`access.data.write\`
3. DHIS2 access string format (8 chars): positions 1-2 = metadata access (r/w), positions 3-4 = data access (r/w)
   - \`"rw------"\` = metadata read+write ONLY — **NO data access** → won't appear in Capture/Data Entry
   - \`"rwrw----"\` = metadata + data read+write → full access, appears everywhere
   - \`"r-rw----"\` = metadata read + data read+write → can capture data but can't edit program config
   - \`"r-r-----"\` = metadata read + data read → view-only
4. Also check \`sharing.userGroups\` — user groups can grant data access even if publicAccess doesn't
5. OU assignment and sharing must both be correct for users to actually use a program in Capture.
**Fix:** \`manage_metadata(action=update_sharing, object_type="programs", object_id="<id>", public_access="rwrw----")\` (+ user_group_accesses / user_accesses entries as needed)
⚠️ **NEVER** use dhis2_query PUT/PATCH to modify sharing — it fails with 405/500. The DHIS2 sharing API is \`PUT /api/sharing?type={singularType}&id={id}\` — update_sharing handles this correctly.`;

const KB_NOTIFICATIONS_DETAILS = `### DHIS2 schema reality (codified in the tool — don't relearn)
- \`ProgramNotificationTemplate\` has **no** \`url\` / \`webhookUrl\` / \`hookUrl\` field. DHIS2 silently drops these keys on POST, then PATCH with \`url\` returns 400 because the property doesn't exist.
- For \`notificationRecipient = WEB_HOOK\`, the URL goes in \`messageTemplate\` (server convention) and \`deliveryChannels\` is auto-set to \`[HTTP]\` by DHIS2's object-bundle hook. The tool's \`webhook_url\` arg handles placement.
- \`subjectTemplate\` max length = 100 chars. Keep variable syntax tight (e.g. \`V{program_name} A{<teaUid>}\`) — the tool rejects overlong values with a hint.
- Linking a template to a program uses a dedicated endpoint: \`POST /api/programs/{programId}/notificationTemplates/{templateId}\`. It is NOT a field on the program you can PATCH.

**One-shot pattern** (most common — "create a webhook on enrollment"):
\`manage_program_notifications(action="create_and_link", program_id="<pid>", name="<title>", trigger="ENROLLMENT", recipient="WEB_HOOK", webhook_url="https://...", message_content="Program: V{program_name} | OU: V{org_unit_name} | A{<teaUid1>}")\`

Triggers: ENROLLMENT | COMPLETION | PROGRAM_RULE | SCHEDULED_DAYS_DUE_DATE | SCHEDULED_DAYS_INCIDENT_DATE | SCHEDULED_DAYS_ENROLLMENT_DATE (SCHEDULED_* requires \`relative_scheduled_days\`).
Recipients: TRACKED_ENTITY_INSTANCE | ORGANISATION_UNIT_CONTACT | USERS_AT_ORGANISATION_UNIT | USER_GROUP (+recipient_user_group_id) | PROGRAM_ATTRIBUTE (+recipient_program_attribute_id) | DATA_ELEMENT (+recipient_data_element_id) | WEB_HOOK (+webhook_url).
Template variables: V{program_name}, V{program_stage_name}, V{org_unit_name}, V{orgunit_id}, V{enrollment_id}, V{event_id}, V{current_date}, A{<teaUid>} for tracked-entity attribute values, #{<deUid>} for program-rule data elements.

**Atomicity** — \`create_and_link\` is all-or-nothing: if the link step fails, the just-created template is auto-deleted so the server stays clean. If the call returns an error, inspect \`rollback.succeeded\` — \`true\` means state is unchanged and you can simply retry. Pre-flight dedup returns an existing same-name template rather than creating a duplicate. **Never** call \`create\` and \`link\` as two separate tool calls for this flow — use \`create_and_link\`.
Leftover/duplicate templates from a prior failed run: \`action="orphan_sweep"\` lists unlinked templates; add \`delete=true\` to remove them.`;

const KB_DATASETS_DETAILS = `### Required fields when creating
- \`dataset_name\` (unique server-wide), \`short_name\` (≤ 50 chars), \`period_type\`, \`category_combo_id\` (defaults to the system "default" combo)
- \`mobile\` is sent automatically as false (deprecated J2ME flag — schema-required)

### period_type — exact case (one of these 20)
Daily, Weekly, WeeklyWednesday, WeeklyThursday, WeeklySaturday, WeeklySunday, BiWeekly, Monthly, BiMonthly, Quarterly, QuarterlyNov, SixMonthly, SixMonthlyApril, SixMonthlyNov, Yearly, FinancialApril, FinancialJuly, FinancialSep, FinancialOct, FinancialNov

### form_type
DEFAULT (single table), SECTION (sectioned form, common for routine reporting), CUSTOM (uses dataEntryForm), SECTION_MULTIORG (sectioned across multiple OUs).

### Category Combo (DISAGGREGATION)
- Each dataset has ONE \`category_combo_id\`. Default is no disaggregation (the system "default" combo).
- Each \`dataSetElement\` (DE attached to the dataset) can OPTIONALLY override with its own \`category_combo_id\`. Use this when one DE in the form has different disaggregation than the rest (e.g., the dataset uses "Sex" but a specific DE uses "Sex × Age").
- Look up category combos via search_metadata(object_type="categoryCombos", name_filter=...) or dhis2_query path "categoryCombos?fields=id,displayName".
- The default combo's UID differs per server. The chatbot resolves it automatically when creating; pass \`category_combo_id\` only to override.
- To CREATE a new combo (+ categories + options) or aggregate DEs bound to one, use create_metadata (create_category_combo / create_data_elements) — its manual has the recipes.

### "Can capture and view" sharing translation
- DataSet (data-shareable): \`rwrw----\` for the user group
- DataElement / CategoryCombo / Category / CategoryOption / OptionSet / TEA / ProgramIndicator (metadata-only-shareable): \`rw------\`
- "Public access None": \`public_access: "--------"\`
- "My user group": resolve via \`dhis2_query path="userGroups?filter=users.id:eq:<currentUserId>&fields=id,name"\` if the user said "my group", or ask the user to name the group.

### Sharing — IMPORTANT FOR DATA ENTRY
DataSets are data-shareable. The 8-char access string positions 3-4 control DATA write. To let users enter data into a dataset, public_access MUST be \`rwrw----\` (or grant rw at positions 3-4 to specific user groups). \`rw------\` allows metadata changes only — users will see the form but the Save button does nothing for them. The tool defaults new datasets to \`rwrw----\` so data entry works out of the box.

### Org-unit assignment
A dataset only appears in a user's Data Entry app for the OUs assigned to it. Use \`manage_datasets(action="assign_org_units", dataset_id, org_unit_ids, merge_mode)\` (merge_mode: replace | add | remove). Without an OU assigned that the user has access to, the dataset is invisible.

### Sections vs Default form
- DEFAULT form: one big table. Use when the dataset has < 20 DEs.
- SECTION form: groups DEs into named sections. Provide \`sections: [{name, sort_order, data_element_ids:[...], indicator_ids:[...], show_row_totals, show_column_totals}]\` at create time, OR add later with action="create_section". Sections show up automatically when form_type="SECTION".

### Common one-call recipes
- "Create a monthly dataset for malaria reporting with these 5 data elements":
  manage_datasets(action="create", dataset_name="Malaria Monthly", period_type="Monthly", form_type="SECTION", data_element_ids=[<de1>,...,<de5>], org_unit_ids=[<ouRoot>], sections=[{name:"Cases", data_element_ids:[<de1>,<de2>,<de3>]}, {name:"Deaths", data_element_ids:[<de4>,<de5>]}])
- "Add these DEs to the current dataset": manage_datasets(action="add_data_elements", dataset_id="<datasetId from context>", data_element_ids=[...])
- "List monthly datasets": manage_datasets(action="list", period_type="Monthly")
- "Make this dataset entry available for users": manage_datasets(action="update_sharing", dataset_id, public_access="rwrw----")

### Common pitfalls (hard-learned)
- shortName must be ≤ 50 chars. The tool clamps automatically.
- Sections cannot have a writable \`categoryCombo\` (DHIS2 derives it from the contained DEs).
- "default" is NOT a valid category-combo id literal — the tool resolves the actual UID via /api/categoryCombos?filter=name:eq:default.
- DataSet \`version\` auto-increments on save — never set it manually.
- \`expiryDays = 0\` and \`openFuturePeriods = 0\` mean "never expires" and "no future periods open", NOT "expires immediately".
- A dataset's "indicators" field is for DISPLAY indicators on the form (read-only sums). DON'T confuse with program indicators.`;

const KB_CUSTOM_FORMS_DETAILS = `### Input-id binding (the ONLY thing that makes a cell save) — the tool builds these for you, but if you hand-write html_code they MUST be exact:
- dataset cell:       \`<input id="<dataElementUID>-<categoryOptionComboUID>-val" title="" value="">\`
- program-stage cell: \`<input id="<programStageUID>-<dataElementUID>-val" title="" value="">\`
Everything else in the HTML (tables, headings, narrative text) renders verbatim.

### Hard-learned quirks the tool already handles — do NOT try to do these by hand:
- The dataEntryForm is created STANDALONE first (POST /api/dataEntryForms); it can never be embedded inline in a dataSet/programStage (E5002).
- Linking to a program stage re-attaches the program reference on a full PUT (a PATCH/naive PUT loses it → "must reference a program").
- A dataset custom form needs sharing rwrw---- + an assigned org unit before users can actually enter data. If the tool's \`_hints\` flag these, fix them with **manage_datasets** (update_sharing / assign_org_units).

### Custom forms × program rules (hide/show) — verified live on Capture 2.40 (2026-07-07)
Program rules KEEP WORKING inside a custom stage form: HIDEFIELD removes the field's input widget and re-shows it dynamically when the condition flips, ASSIGN fills values, SHOWWARNING renders inline under the input. Do NOT try to re-implement hiding inside the HTML (scripts are not executed by Capture) and do NOT tell users hide/show is impossible with custom forms. But there are TWO user-visible differences you MUST proactively explain whenever a program combines a custom form with hide/show rules:
1. **Orphan labels:** the custom HTML around the input (the label cell / table row the generator emits) stays visible when the input is hidden — the user sees a label with an empty value cell. In the DEFAULT (section) form the whole row disappears. If pixel-perfect hiding matters more than the custom design, recommend skipping the custom form for that stage.
2. **HIDEPROGRAMSTAGE** (any form type) in the new Capture web app only disables adding events to the stage — the stage card remains on the enrollment dashboard (see the program-rule KB).
Also remind users that a rule hiding fields "when X is not Y" hides them while X is still EMPTY — the fields appear only after the trigger value is chosen. That is the rule doing its job, not the form breaking.

### Recipes
- "Make a custom form for this dataset": manage_custom_forms(action="set_dataset_form", dataset_id="<id>")  // auto-generates from its DEs
- "Design a custom form for this tracker stage": manage_custom_forms(action="set_stage_form", program_stage_id="<stageId>")
- "Show me what the form would look like first": manage_custom_forms(action="preview_html", dataset_id|program_stage_id)
- "Use my own HTML": pass html_code="..." with the correct id bindings above.`;

const KB_VALIDATION_RULES_DETAILS = `### Expressions (both sides)
- \`#{dataElementUid}\` = the data element summed across all its category-option-combos.
- \`#{dataElementUid.categoryOptionComboUid}\` = one specific disaggregation cell.
- \`C{constantUid}\` for constants; numeric literals and \`+ - * /\` are allowed (e.g. \`#{de1} + #{de2}\`).
- The tool server-validates BOTH expressions via DHIS2's \`/expressions/description\` endpoint BEFORE saving. A bad UID or malformed syntax is rejected at create/update time with the parser's exact error — fix the expression and retry, don't loop.
- Look up data-element UIDs with search_metadata(object_type="dataElements") or manage_datasets(action=get) — NEVER invent UIDs.

### operator (leftSide <op> rightSide)
equal_to, not_equal_to, greater_than, greater_than_or_equal_to, less_than, less_than_or_equal_to, compulsory_pair (both sides must have a value or neither), exclusive_pair (at most one side may have a value).

### Other fields
- importance: HIGH | MEDIUM | LOW (default MEDIUM).
- period_type: same 20 exact-case values as datasets (Monthly, Quarterly, Yearly, …); default Monthly. Pick the period at which the compared totals are meaningful.
- left_missing_strategy / right_missing_strategy: NEVER_SKIP (default — a missing value counts as 0), SKIP_IF_ANY_VALUE_MISSING, SKIP_IF_ALL_VALUES_MISSING. Use a SKIP_* strategy when a missing value should suppress the check instead of being treated as 0.
- instruction: the message shown to the data-entry user when the rule fails — phrase it as what to check/fix.

### Examples
- "Inpatient days must not exceed available bed-days (monthly)": create rule { name, operator:"less_than_or_equal_to", period_type:"Monthly", left_expression:"#{inpatientDaysUid}", right_expression:"#{bedDaysUid}", importance:"MEDIUM" }.
- "ANC 4th visits should never exceed ANC 1st visits": operator "less_than_or_equal_to", left=#{anc4}, right=#{anc1}.
- "Sex sub-totals must equal the grand total": operator "equal_to", left="#{deMale} + #{deFemale}", right="#{deTotal}".`;

const KB_ORG_UNITS_DETAILS = `### The one rule that trips people up: level & path are DERIVED, never set
- A unit's \`level\` and \`path\` come from its parent — DHIS2 computes them. You pass only \`parent_id\`; a child of a level-3 chiefdom automatically becomes level 4 with path = parentPath + "/" + newId. NEVER put level or path in the org_unit object.

### create
- Required: org_unit.name, org_unit.opening_date (YYYY-MM-DD), and org_unit.parent_id for every non-root unit. short_name defaults to name (≤50 chars).
- The tool verifies the parent exists first and reports the derived level. Resolve the parent UID with manage_org_units(action=list) or search_metadata — NEVER invent it.
- FRESH / EMPTY instance: to create the FIRST org unit (the root, e.g. a country), call create with NO parent_id. The tool allows this ONLY when the instance has zero org units; once a root exists, every further unit needs a parent_id (a second root is refused). Build a hierarchy top-down: create the root, then create each child passing the parent_id returned by the previous create.
- Use dry_run_only:true to validate (incl. the parent reference) without committing.

### update / move (re-parent)
- Patch any field (name, short_name, opening_date, closed_date — pass "" to clear closed_date — code, description, comment, contact fields).
- Supplying org_unit.parent_id MOVES the unit; DHIS2 re-computes level/path for it AND all descendants. The tool rejects a move under the unit's own descendant (cycle) and under itself. Auto-backup first.

### delete
- Only LEAF units delete. The tool refuses a unit that still has children (re-parent or delete them bottom-up first) and lets DHIS2 block any unit still holding data values / program-dataset assignments / user scope, surfacing the exact reason. Auto-backup first.

### Examples
- "Add a new facility 'Bo CHC' under Badjia chiefdom (opened 2015-01-01)": create with org_unit:{ name:"Bo CHC", parent_id:"<BadjiaUID>", opening_date:"2015-01-01" }.
- "Move the Ngelehun clinic under Kakua chiefdom instead": update org_unit_id=<clinic> org_unit:{ parent_id:"<KakuaUID>" }.
- "Close facility X as of 2024-12-31": update org_unit:{ closed_date:"2024-12-31" }.`;

const KB_INDICATORS_DETAILS = `### Expressions (numerator & denominator)
- \`#{dataElementUid}\` = data element summed across all its category-option-combos; \`#{dataElementUid.cocUid}\` = one disaggregation cell.
- \`R{dataSetUid.REPORTING_RATE}\` (also ACTUAL_REPORTS, EXPECTED_REPORTS, …) for reporting rates; \`I{programIndicatorUid}\` to reuse a program indicator; \`C{constantUid}\` for constants; numeric literals and \`+ - * /\` are allowed.
- For a plain count/sum, set denominator to \`"1"\`.
- The tool server-validates BOTH expressions via DHIS2's \`/expressions/description\` endpoint BEFORE saving — fix and retry on rejection, don't loop.
- Look up UIDs with search_metadata / manage_datasets(action=get) — NEVER invent them.

### indicator_type (the scaling factor)
Pass a UID or the exact name. Common types: **"Number (Factor 1)"** (×1 — raw ratio/count), **"Per cent"** (×100), **"Per thousand"**, **"Per ten thousand"**, **"Per hundred thousand"**. The tool resolves and verifies the type before writing.

### Other fields
- short_name: ≤50 chars (defaults to name). annualized: scale to a full year for the chosen period (default false). decimals: 0–5 fixed output decimals (omit to inherit the default). numerator_description / denominator_description: auto-derived from DHIS2 if omitted.
- legend_set_id: attach an EXISTING legend set so the indicator renders colour-coded on dashboards/pivots/maps (create it first with manage_legend_sets).

### Examples
- "ANC 1 coverage as a percentage of expected pregnancies": create indicator:{ name:"ANC 1 Coverage", indicator_type:"Per cent", numerator:"#{anc1Uid}", denominator:"#{expectedPregnanciesUid}" }.
- "Maternal deaths per 100,000 live births": indicator_type:"Per hundred thousand", numerator:"#{maternalDeaths}", denominator:"#{liveBirths}".
- "Total malaria cases (a plain sum)": indicator_type:"Number (Factor 1)", numerator:"#{malariaConfirmed} + #{malariaClinical}", denominator:"1".`;

const KB_OPTION_SETS_DETAILS = `### Actions in detail
- **list** (name / value_type filters) and **get** (returns options in display order) are read-only.
- **create** — a new standalone set + its options, imported atomically (VALIDATE then COMMIT). Pass \`option_set:{ name, value_type, options:[{code,name},…] }\`. value_type defaults to TEXT if omitted. Codes must be unique within the set.
- **add_options** — append new options to an existing set: \`option_set_id\` + \`options:[{code,name},…]\`. New codes must not collide with existing ones.
- **remove_options** — delete options from a set by \`option_codes:[…]\` or \`option_ids:[…]\`. Deletes the option objects (which auto-detaches them); refuses to remove the last remaining option.
- **reorder_options** — set display order via \`order:[…]\` listing every current option's code (or UID) in the desired sequence.
- **update** — patch the set's OWN fields (name / code / description / value_type) only — never membership.
- **delete** — remove the whole set (and its options); refuses with the exact blockers if any data element or tracked-entity attribute still uses it.

### Rules
- update / add_options / remove_options / reorder_options / delete each auto-snapshot a backup first (restore via manage_backups).
- NEVER invent option-set or option UIDs — get them from search_metadata / action=get.

### Examples
- "Create an HIV Result option set with Positive/Negative/Inconclusive": create option_set:{ name:"HIV Result", value_type:"TEXT", options:[{code:"POS",name:"Positive"},{code:"NEG",name:"Negative"},{code:"INC",name:"Inconclusive"}] }.
- "Add a 'Refused' choice to that set": add_options option_set_id:"<id>", options:[{code:"REF",name:"Refused"}].
- "Put Negative before Positive": reorder_options option_set_id:"<id>", order:["NEG","POS","INC"].`;

const KB_LEGEND_SETS_DETAILS = `### Ranges
- Bands are **half-open [startValue, endValue)**: a band matches values >= startValue and < endValue, so a band's endValue may equal the next band's startValue without overlapping. endValue must be > startValue.
- DHIS2 does NOT reject overlapping or gapped bands. This tool returns an overlap **warning** (it never blocks) — relay any warning to the user.
- \`color\` is an optional 6-digit hex (#RRGGBB); the tool canonicalises "#rrggbb"/"rrggbb".

### Actions in detail
- **create** — EITHER pass explicit \`legend_set:{ name, legends:[{name,startValue,endValue,color?},…] }\`, OR pass \`legend_set:{ name }\` + \`auto_bands:{ start, end, count }\` to auto-generate \`count\` equal-width contiguous bands on a red→amber→green (low→high) ramp. \`auto_bands.colors\` / \`auto_bands.names\` (length == count) override the defaults.
- **add_legends** — append bands (\`legend_set_id\` + \`legends:[…]\`; new names must not collide). **remove_legends** — drop bands by \`legend_names:[…]\` or \`legend_ids:[…]\`; refuses to remove the last band.
- **update** — the set's OWN fields (name / code) only. **delete** — removes the whole set; refuses with exact blockers if still in use.
- All mutating actions auto-snapshot a backup first (restore via manage_backups).

### Attaching (a legend set only DEFINES the scale)
To an aggregate **indicator**: pass the set's UID as \`legend_set_id\` to manage_indicators(action="create"|"update"). For a data element, visualisation or map layer, set the legend in the relevant app — NEVER attempt any legend attach via raw dhis2_query PATCH or manage_metadata (it has NO legend action).

### Examples
- "Make a coverage legend, red→green, 0 to 100 in 5 bands": create legend_set:{ name:"Coverage 0–100" }, auto_bands:{ start:0, end:100, count:5 }.
- "Create a stockout legend: 0 red, 1–10 amber, 11+ green": create legend_set:{ name:"Stock status", legends:[{name:"Out",startValue:0,endValue:1,color:"#D32F2F"},{name:"Low",startValue:1,endValue:11,color:"#FBC02D"},{name:"OK",startValue:11,endValue:1000000,color:"#388E3C"}] }.
- "Add a 'Very high' 100–150 band": add_legends legend_set_id:"<id>", legends:[{name:"Very high",startValue:100,endValue:150,color:"#1B5E20"}].`;

const KB_DASHBOARDS_DETAILS = `### Why a raw POST silently fails (and this tool does not)
DHIS2 stores a visualization's LAYOUT as \`columnDimensions\`/\`rowDimensions\`/\`filterDimensions\` (lists of dimension ids) and its DATA as \`dataDimensionItems\` (typed dx items) + \`relativePeriods\`/\`periods\` (pe) + \`organisationUnits\`/\`organisationUnitLevels\`/\`userOrganisationUnit\` (ou). The \`columns\`/\`rows\`/\`filters\` arrays are DERIVED read-only views — a raw POST that only sets them imports an EMPTY, un-renderable chart. This tool assembles the correct structure (verified VALIDATE+COMMIT on the live server).

### Fields
- **vis_type**: COLUMN, STACKED_COLUMN, BAR, STACKED_BAR, LINE, AREA, PIE, RADAR, GAUGE, SINGLE_VALUE, PIVOT_TABLE, YEAR_OVER_YEAR_LINE, … (default COLUMN).
- **periods**: relative keywords (LAST_12_MONTHS, THIS_YEAR, LAST_4_QUARTERS, MONTHS_THIS_YEAR, …) and/or fixed ISO periods (202401, 2025Q1, 2025).
- **org_units**: UIDs and/or relative keywords USER_ORGUNIT, USER_ORGUNIT_CHILDREN, USER_ORGUNIT_GRANDCHILDREN, or LEVEL-<n> (e.g. LEVEL-2 = all level-2 OUs).
- **layout** (optional): which of dx/pe/ou sit on columns/rows/filters. Sensible per-type defaults apply (pivot → cols[pe]/rows[dx]; single-value/gauge/pie → cols[dx], pe+ou in filter; charts → cols[dx]/rows[pe]).

### Rules
- data_items types (indicator / dataElement / programIndicator) are auto-resolved AND existence-verified; an invalid UID is rejected, not silently dropped. NEVER invent visualization, map or data-item UIDs.
- add_items reads the full dashboard, appends below the current tiles, and writes the COMPLETE item set back, snapshotting to backups first. NEVER add to a dashboard with a raw dhis2_query PUT /dashboards/{id} — a dashboard PUT is a whole-object REPLACE that permanently wipes every existing tile (now blocked in code).
- Items are auto-arranged on the 58-column grid (override per item with x/y/width/height). Item shapes: { visualization_id } | { type:"MAP", map_id } | { type:"EVENT_VISUALIZATION", event_visualization_id } (a saved line list from manage_line_lists) | { type:"TEXT", text } | { new_visualization:{ name, vis_type, data_items, periods, org_units } }.
- To delete a whole dashboard use action="delete" (snapshots first). Sharing/deletion of standalone visualizations/maps → manage_metadata.

### Examples
- "Build an ANC dashboard with a coverage chart, a pivot and a single value": create_dashboard dashboard:{ name:"ANC Programme" }, items:[ {new_visualization:{name:"ANC Coverage by Month",vis_type:"COLUMN",data_items:["<anc1>","<anc2>"],periods:["LAST_12_MONTHS"],org_units:["<ou>"]}}, {new_visualization:{name:"ANC 1 This Year",vis_type:"SINGLE_VALUE",data_items:["<anc1>"],periods:["THIS_YEAR"],org_units:["<ou>"]}} ].
- "Make me a column chart of malaria cases by district last year": create_visualization visualization:{ name:"Malaria cases by district", vis_type:"COLUMN", data_items:["<de>"], periods:["LAST_YEAR"], org_units:["LEVEL-2"] }.
- "Add a coverage chart to my National Overview dashboard": add_items dashboard_id:"<dashId>", items:[ { new_visualization:{ name:"ANC coverage", vis_type:"COLUMN", data_items:["<indicatorId>"], periods:["LAST_12_MONTHS"], org_units:["USER_ORGUNIT"] } } ] — this APPENDS; existing tiles are preserved and snapshotted.`;

const KB_TRANSLATIONS_DETAILS = `### How the feature works (verified on 2.43 — the app fetches both keys at startup)
- Registry key "controller": { "<appSlug>": ["<locale>", ...] }. If an app/locale is NOT registered here, the app never loads its translations (this tool keeps it in sync automatically).
- Per app+locale key "<slug>__<locale>" (double underscore, e.g. capture__ar): { "<exact source string>": "<replacement>", ... }. The app swaps each matching source string at render time.

### Two uses (identical mechanics — a literal source→target string map)
- TRANSLATE: locale is another language (e.g. "ar","fr") → English source renders as the translation.
- REWRITE same language: locale is the language already shown (e.g. "en") → relabel/reword in place, e.g. "Report data" → "Submit report".

### Critical
- Match each source string EXACTLY as shown on screen (capitalisation, punctuation, whitespace) — read the real UI text first; an inexact key is silently ignored.
- The app slug is lowercase (capture, dashboard, data-visualizer, maps). The user must reload the app with that locale active to see changes.
- Requires DHIS2 2.43+; the tool refuses on older servers.
- DataStore keys are NOT covered by manage_backups. set/remove return previous_value / previous_controller for manual rollback — surface the key name to the user.

### Recipes
- "Translate Capture to Arabic": manage_custom_translations(action="set", app="capture", locale="ar", translations={"Report data":"...", ...})
- "Rename a button in English": manage_custom_translations(action="set", app="capture", locale="en", translations={"Report data":"Submit report"})
- "What translations exist?": action="list". "Undo the Arabic translation": action="remove", app="capture", locale="ar".`;

const KB_GROWTH_CHART_DETAILS = `### Typical order
status (run this first) → install (if needed) → configure(program_id) → relay the returned \`dashboard_attach\` steps.

### Hard requirements (the tool validates and refuses with a list if unmet)
The program MUST have a Date-of-birth (DATE) attribute and a Gender/sex attribute with an option set, and the stage MUST have weight + height + head-circumference data elements. If any of the three DEs is missing the chart will not display. If configure reports missing metadata, offer scaffold_program or ask the user for the exact attribute/DE ids.

### Making it visible
configure makes the plugin FUNCTION but does not place the widget. Relay the tool's \`dashboard_attach\` block: the plugin must be added to the enrollment dashboard via the Tracker Plugin Configurator app (or Capture's "Add plugin" with the returned plugin source URL). The tool deliberately does NOT write dataStore/capture (Capture-owned; risk of cache corruption).

### Recipe
- "Set up the growth chart plugin for <program>": status → install (if needed) → configure(program_id) → relay dashboard_attach steps.
- "I have no program for it": scaffold_program(org_unit_id) → configure(created program) → install. defaultIndicator is one of: wfa, hcfa, lhfa, wflh.`;

// Per-tool manual extras: the deep KB text appended to the tool's original
// description when its manual is delivered. Shared grammar blocks appear in
// every manual that needs them.
// ── Line-list KB — deep how-to for manage_line_lists (delivered in its manual) ──
const KB_LINE_LISTS_DETAILS = `## DHIS2 Line Lists (manage_line_lists)
A **line list** is a saved row-per-record table (one row per event / enrollment / person) opened in the Line Listing app and embeddable on dashboards. It is stored as an \`eventVisualization\` with \`type: LINE_LIST\` — a DIFFERENT object from the aggregate \`visualizations\` that manage_dashboards creates. Aggregated charts/pivots → manage_dashboards; row-level tables → THIS tool.

**Choosing output_type (the single most important decision):**
- \`EVENT\` — one row per event of ONE program stage. Needs \`program_stage_id\` on multi-stage tracker programs. Columns: that stage's DEs + program attributes + EVENT-analytics PIs.
- \`ENROLLMENT\` — one row per enrollment. Columns may come from ANY stage (auto-qualified), attributes, ENROLLMENT-analytics PIs, and repeatable-stage DEs can repeat: \`repeated_events:{ most_recent:2, oldest:2 }\` renders "Adherence [1] [2] [-1] [0]"-style columns. Use for treatment-monitoring / cohort registers.
- \`TRACKED_ENTITY\` — one row per person (attributes + org unit; the program still anchors the dimensions).

**A senior implementor's workflow for a monitoring register:**
1. get_program_info → real stage/DE/attribute names + UIDs.
2. Row-level metrics DON'T exist as columns? Create ENROLLMENT-analytics PIs with manage_program_indicators — per-row-safe patterns: \`d2:count(#{stage.de})\` (visits recorded), \`d2:countIfValue(#{stage.de}, 'CODE')\` (e.g. poor-adherence months), \`d2:daysBetween(V{enrollment_date}, V{event_date})\`, \`d2:condition("…", 1, 0)\` flags. ⚠ NEVER put a rate/percentage PI (any division) in a line list — per-row zero denominators 409 the WHOLE table. The tool refuses them; that refusal is final unless the user insists (allow_risky_program_indicator). ⚠ **aggregation_type matters per row** (verified live on 2.42): give count-style PIs \`aggregation_type:"SUM"\` — with COUNT the line-list cell shows a constant 1 for every row (COUNT counts the one enrollment row, not the events), and with NONE the whole query fails with an SQL error (the tool refuses NONE PIs as columns and warns on COUNT+d2:count).
3. Colour-coding: manage_legend_sets(action=create) → pass legend:{ legend_set_id, strategy:"FIXED", style:"FILL" }. FILL = cell background (scorecard look). Legends colour NUMERIC columns (PIs, numeric DEs).
4. create with data_check="require_rows" when the user expects data — an empty register usually means wrong period/org units or analytics tables not yet run (the result tells you which).
5. Dashboard: manage_dashboards(action="create_dashboard"|"add_items") with items [{ type:"EVENT_VISUALIZATION", event_visualization_id:"<line_list_id>" }].

**Filters** (on columns or the filters axis): option-set dims take option CODES (names auto-map; \`{operator:"IN", values:["CODE_A","CODE_B"]}\`), booleans take true/false, numerics EQ/NE/GT/GE/LT/LE, text LIKE/EQ. Multiple conditions on one dimension: \`{conditions:[{operator:"GE", value:5},{operator:"LT", value:10}]}\`.
**Periods**: relative keywords (LAST_12_MONTHS, THIS_QUARTER, LAST_4_QUARTERS, THIS_YEAR, …) mix freely with fixed ISO (202605, 2026Q1, 2026). Time dimensions differ per output_type: EVENT has event_date/enrollment_date/incident_date/scheduled_date/last_updated; ENROLLMENT has enrollment_date/incident_date/last_updated.
**Org units**: USER_ORGUNIT (+_CHILDREN/_GRANDCHILDREN), LEVEL-<n>, OU_GROUP-<uid>, explicit UIDs — combinable (e.g. LEVEL-4 under a parent UID).
**Sorting**: only by columns of the list; pass the column's name/UID + ASC/DESC.

**Diagnosing "the line list shows an error / is empty"** → action=validate on the saved list: it re-runs the app's exact query and returns row_count or the offending dimension. Division-PI columns and analytics-tables-not-run are the two most common causes.
**Zero-invention rule**: every dimension resolves against the program's real metadata at call time; a typo'd name returns the valid candidates instead of saving a broken list. Never invent UIDs; never POST/PUT eventVisualizations via dhis2_query.`;

const MANUAL_EXTRAS = {
  create_metadata: [KB_CREATE_PROGRAM_DETAILS, KB_VALUE_TYPE_MAPPING, KB_PROGRAM_RULE_SYNTAX, KB_PI_GRAMMAR].join('\n\n'),
  manage_metadata: [KB_METADATA_DELETE_FLOW, KB_METADATA_TEA_OU, KB_METADATA_ICON_FLOW, KB_METADATA_SHARING].join('\n\n'),
  manage_program_rules: KB_PROGRAM_RULE_SYNTAX,
  manage_program_indicators: KB_PI_GRAMMAR,
  manage_program_notifications: KB_NOTIFICATIONS_DETAILS,
  manage_datasets: KB_DATASETS_DETAILS,
  manage_custom_forms: KB_CUSTOM_FORMS_DETAILS,
  manage_validation_rules: KB_VALIDATION_RULES_DETAILS,
  manage_org_units: KB_ORG_UNITS_DETAILS,
  manage_indicators: KB_INDICATORS_DETAILS,
  manage_option_sets: KB_OPTION_SETS_DETAILS,
  manage_legend_sets: KB_LEGEND_SETS_DETAILS,
  manage_dashboards: KB_DASHBOARDS_DETAILS,
  manage_line_lists: KB_LINE_LISTS_DETAILS,
  manage_custom_translations: KB_TRANSLATIONS_DETAILS,
  manage_growth_chart_plugin: KB_GROWTH_CHART_DETAILS,
  // manage_maps: full description already covers usage; no extra KB.
};

// ── Slim wire definitions ──
const SLIM_DESC_LIMIT = 180;
const MANUAL_NOTE = ' ⓘ Two-tier docs: your FIRST call to this tool each turn returns its full usage manual instead of executing — read it, then immediately re-issue the (corrected) call.';

function slimDescriptionText(text) {
  const s = String(text || '');
  if (s.length <= SLIM_DESC_LIMIT) return s;
  const window = s.slice(0, SLIM_DESC_LIMIT);
  const cut = window.lastIndexOf('. ');
  const head = cut > 40 ? window.slice(0, cut + 1) : window.replace(/\s+\S*$/, '');
  return head + ' …(details in the tool manual)';
}

// Build the slim wire schema: top-level property names, types, enums and
// required list are preserved exactly; long prose is truncated; NESTED object
// shapes are collapsed to a field-name list in the description (their full
// spec is in the manual, which the gate guarantees the model reads before the
// first real execution).
function slimSchema(parameters) {
  if (!parameters || typeof parameters !== 'object') return parameters;
  const out = { type: parameters.type || 'object', properties: {} };
  if (Array.isArray(parameters.required)) out.required = [...parameters.required];
  for (const [name, def] of Object.entries(parameters.properties || {})) {
    out.properties[name] = slimSchemaProp(def);
  }
  return out;
}

// Bare type/enum/structure skeleton of a schema subtree — property names and
// types WITHOUT descriptions. Nested objects MUST keep their property lists on
// the wire: providers with grammar-constrained tool-call decoding (observed
// live 2026-07-18 on Fireworks/MiniMax-M3) cannot emit fields they have no
// spec for — given `items: {type:'object'}` the constrainer wrapped each item
// as `{"$text": "<the object as a JSON string>"}`, which reached the tool as
// objects with no usable fields and dead-looped create_program. The skeleton
// costs a few hundred tokens and makes every constrained decoder emit real
// objects. (agent.js also heals $text-style wrapping as a safety net.)
function schemaSkeleton(def) {
  if (!def || typeof def !== 'object') return {};
  const out = {};
  if (def.type) out.type = def.type;
  if (Array.isArray(def.enum)) out.enum = [...def.enum];
  if (def.type === 'array' && def.items && typeof def.items === 'object') out.items = schemaSkeleton(def.items);
  if (def.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(def.properties)) out.properties[k] = schemaSkeleton(v);
    if (Array.isArray(def.required) && def.required.length) out.required = [...def.required];
  }
  return out;
}

function slimSchemaProp(def) {
  if (!def || typeof def !== 'object') return def;
  const out = {};
  if (def.type) out.type = def.type;
  if (Array.isArray(def.enum)) out.enum = [...def.enum];
  if (def.oneOf) out.oneOf = def.oneOf;
  let desc = def.description ? slimDescriptionText(def.description) : '';
  if (def.type === 'array' && def.items && typeof def.items === 'object') {
    if (def.items.properties) {
      out.items = schemaSkeleton(def.items);
      desc += (desc ? ' ' : '') + 'Item fields: ' + Object.keys(def.items.properties).join(', ') + ' — full spec in the manual.';
    } else {
      out.items = {};
      if (def.items.type) out.items.type = def.items.type;
      if (Array.isArray(def.items.enum)) out.items.enum = [...def.items.enum];
    }
  } else if (def.properties) {
    out.properties = schemaSkeleton(def).properties;
    desc += (desc ? ' ' : '') + 'Object fields: ' + Object.keys(def.properties).join(', ') + ' — full spec in the manual.';
  } else if (def.additionalProperties) {
    out.additionalProperties = def.additionalProperties;
  }
  if (desc) out.description = desc;
  return out;
}

// Convert the contextual tool selection into what is actually sent to the
// provider. Non-MANUAL_TOOLS pass through untouched; MANUAL_TOOLS get the slim
// routing description + slimmed schema (with the `action` enum description
// kept in full — it is routing information the model needs at decide time).
function toWireTools(tools) {
  return tools.map(t => {
    const name = t?.function?.name;
    if (!name || !MANUAL_TOOLS.has(name)) return t;
    const orig = t.function;
    const params = slimSchema(orig.parameters);
    const origActionDesc = orig.parameters?.properties?.action?.description;
    if (origActionDesc && params?.properties?.action) {
      params.properties.action.description = origActionDesc;
    }
    return {
      type: 'function',
      function: {
        name,
        description: (TOOL_SUMMARIES[name] || slimDescriptionText(orig.description)) + MANUAL_NOTE,
        parameters: params,
      },
    };
  });
}

// Render a complete, readable parameter reference from the ORIGINAL schema so
// the manual loses nothing relative to the old always-in-context definitions.
function renderParamDocs(schema, indent = '') {
  if (!schema || typeof schema !== 'object' || !schema.properties) return '';
  let out = '';
  const required = new Set(schema.required || []);
  for (const [name, def] of Object.entries(schema.properties)) {
    if (!def || typeof def !== 'object') continue;
    const bits = [];
    if (def.type) bits.push(def.type);
    if (required.has(name)) bits.push('REQUIRED');
    if (Array.isArray(def.enum)) bits.push('one of: ' + def.enum.join(' | '));
    const itemEnum = def.items && Array.isArray(def.items.enum) ? ' (each one of: ' + def.items.enum.join(' | ') + ')' : '';
    out += `${indent}- \`${name}\`${bits.length ? ' (' + bits.join(', ') + ')' : ''}${itemEnum}${def.description ? ': ' + def.description : ''}\n`;
    const child = def.type === 'array' ? def.items : def;
    if (child && typeof child === 'object' && child.properties) {
      out += renderParamDocs(child, indent + '  ');
    }
  }
  return out;
}

function buildToolManual(name) {
  const tool = TOOLS.find(t => t.function.name === name);
  if (!tool) return null;
  const extras = MANUAL_EXTRAS[name];
  return [
    `# ${name} — FULL USAGE MANUAL`,
    tool.function.description,
    extras ? extras : null,
    `## Parameter reference (${name})`,
    renderParamDocs(tool.function.parameters) || '(no parameters)',
  ].filter(Boolean).join('\n\n');
}

function buildManualGateResult(name) {
  return {
    _tool_manual: name,
    manual: buildToolManual(name),
    _note: `First use of ${name} this turn — the full manual above was delivered INSTEAD of executing. Nothing was executed and no API call was made. This is the normal two-tier docs flow, NOT an error.`,
    _next_step: `Check your intended arguments against the manual, correct anything that does not match it, and RE-ISSUE the ${name} tool call now — it will execute immediately. Do not mention this manual to the user.`,
  };
}

// History persistence: a delivered manual is only needed for the turn it was
// delivered in (the gate re-delivers next turn if the tool is used again), so
// replace its bulk with a compact stub instead of dragging ~2k chars of
// truncated manual through every subsequent request.
function stubToolContentForHistory(content) {
  if (typeof content === 'string' && content.startsWith('{"_tool_manual"')) {
    try {
      const name = JSON.parse(content)._tool_manual;
      return JSON.stringify({ _tool_manual: name, note: 'Usage manual was delivered here (content omitted from history; it is re-delivered automatically on first use in a new turn).' });
    } catch { /* fall through to normal truncation */ }
  }
  return truncateToolContentForHistory(content);
}

// ── Dynamic Tool Selection ────────────────────────────────────────────────────
// Returns only tools relevant to the current context and user intent.
// Keeping the tool list small prevents context-window overflow and helps
// the model make better routing decisions.  Every extra tool is wasted
// context tokens and an invitation for the LLM to pick the wrong one.
function getContextualTools(ctx, userText, browseWeb, inspectSnapshot = null) {
  const appType = (ctx?.appType || '');
  const lowerText = String(userText || '').toLowerCase();
  const inspectText = inspectSnapshot?.enabled
    ? JSON.stringify({
        insights: inspectSnapshot.insights,
        sample: (inspectSnapshot.logs || []).slice(-20).map(l => ({
          level: l.level,
          source: l.source,
          kind: l.kind,
          text: l.text,
          url: l.url,
          status: l.status,
        })),
      }).toLowerCase()
    : '';
  const combinedText = `${lowerText}\n${inspectText}`;
  const wantsProgramChangeHistory =
    /\b(recent changes|what changed|changes made|change history|history of changes|recent modifications|modified in the last|updated in the last|changes in the last)\b/.test(combinedText)
    && /\bprogram|stage|data element|metadata|family health file|this program\b/.test(combinedText);

  // Intent-based flags — detected from user text, independent of app context.
  // Authoring tools must be available whenever the user clearly expresses metadata
  // creation/management intent, even on pages like Data Visualizer or Maps.
  const wantsCreateIntent =
    /\b(create|build|design|make|set up|setup|add|new)\b.{0,120}\b(program|stage|data ?element|option set|indicator|rule|attribute|metadata|tracker|tracked entity|category|category combo|category combination|cat combo|categorycombo|disaggregation|dataset|data set|aggregate program)\b/.test(combinedText)
    || /\b(tracker|event|program) (program|without registration|with registration)\b/.test(combinedText)
    || /\bnew (tracker|program|stage|data element|option set|indicator|rule|category|category combo|category combination|disaggregation|dataset|data set)\b/.test(combinedText);
  const wantsManageIntent =
    /\b(delete|remove|drop|detach|unassign|clean up|update|modify|change|fix|grant|give|enable|set|share|assign)\b.{0,120}\b(program|stage|data ?element|option set|attribute|metadata|sharing|access|permission|org unit|organisation unit|ou|category|category combo|category combination|disaggregation|dataset|data set)\b/.test(combinedText);
  const wantsSharingIntent =
    /\b(sharing|shared|access|permission|publicaccess|public access|user group access|share with|include me|include my user)\b/.test(combinedText)
    || /\b(make|set|mark|publish|share)\b.{0,30}\bpublic(ly)?\b/.test(combinedText)
    || /\bpublic(ly)?\b.{0,25}\b(access|sharing|visible|to\s+everyone|to\s+all)\b/.test(combinedText)
    || /\bshare[ds]?\b.{0,40}\bwith\b.{0,40}\b(everyone|all\s+users|the\s+public|public|user\s*group|colleagues?|team)\b/.test(combinedText)
    || /\b(give|grant)\b.{0,30}\b(everyone|all\s+users)\b.{0,20}\baccess\b/.test(combinedText);
  const wantsIconStyleIntent = /\b(icon|color|colour|style)\b/.test(combinedText)
    && /\b(program|stage|data ?element|option set|attribute|tea|indicator|option)\b/.test(combinedText);
  const wantsNotificationsIntent =
    /\b(program notifications?|notification templates?|webhooks?|web[- ]?hook)\b/.test(combinedText)
    || (/\b(notify|notification|alert)\b/.test(combinedText)
        && /\b(enrollment|completion|program rule|scheduled days?|due date|incident date)\b/.test(combinedText))
    || /\b(send|post)\b.{0,40}\b(webhook|notification|to\s+(?:a\s+)?(?:url|endpoint))\b/.test(combinedText);
  // The user is asking about backups, restoration, or undoing a recent
  // change — surface manage_backups so the model can list/restore without
  // a separate prompting round.
  const wantsBackupIntent =
    /\b(backup|backups|snapshot|snapshots|restore|rollback|roll back|revert|undo|recover|recovery)\b/.test(combinedText)
    || /\b(deleted|removed|changed|updated)\b.{0,40}\b(by mistake|accident|wrong|wrongly)\b/.test(combinedText)
    || /\b(bring back|put back|get back|restore)\b/.test(combinedText);
  // ── Dataset / Aggregate-data intent ──
  // Catches phrasings like "create a dataset for this aggregate program",
  // "add data elements to this dataset", "what dataset am I in", "make a
  // monthly aggregate form", "data entry form for this program", etc.
  // "Aggregate program" is user shorthand for a dataSet — we treat both terms
  // as triggering manage_datasets.
  const wantsDatasetIntent =
    /\b(data\s*sets?|datasets?)\b/.test(combinedText)
    || /\b(aggregate|aggregated)\b.{0,40}\b(program|programme|data|form|entry|reporting|report)\b/.test(combinedText)
    || /\b(data\s*entry|aggregate\s*data\s*entry|entry\s*form|reporting\s*form|aggregate\s*form)\b/.test(combinedText)
    || /\b(period\s*type|monthly\s*form|weekly\s*form|quarterly\s*form|yearly\s*form|monthly\s*report|weekly\s*report)\b/.test(combinedText)
    || /\b(category\s*combo|category\s*combination|disaggregation|cat\s*combo)\b/.test(combinedText)
    || /\b(data\s*set\s*sections?|dataset\s*sections?)\b/.test(combinedText);
  // ── Custom-form intent ──
  // "custom form", "custom data entry form", "design a form", "html form",
  // "custom layout", "form designer" — for datasets OR program stages.
  const wantsCustomFormIntent =
    /\b(custom\s*forms?|custom\s*(data\s*)?entry\s*forms?|custom\s*layout|html\s*forms?|form\s*designer|dataentryform)\b/.test(combinedText)
    || (/\b(design|build|create|make|lay\s*out|customi[sz]e)\b.{0,40}\b(form|layout)\b/.test(combinedText)
        && /\b(custom|html|data\s*entry|tracker|stage|dataset|data\s*set|aggregate)\b/.test(combinedText));
  // ── Custom-translation intent ──
  // "translate this app", "custom translation(s)", "translate Capture to Arabic",
  // "relabel/rename/change a UI string/label/wording", "localise the app".
  const wantsTranslationIntent =
    /\b(custom\s*translations?|translate|translations?|localis[ez]e|localiz[ae]tion)\b/.test(combinedText)
    || /\b(re-?label|re-?name|change|reword|customi[sz]e)\b.{0,40}\b(label|string|text|wording|caption|button|title|heading|menu\s*item)\b/.test(combinedText);
  // ── Growth-chart plugin intent ──
  // "growth chart/monitoring plugin", "WHO growth", anthropometry, weight/height-for-age,
  // head circumference chart, child growth.
  const wantsGrowthChartIntent =
    /\b(growth\s*chart|growth\s*monitoring|who\s*growth|anthropomet|weight[-\s]?for[-\s]?age|height[-\s]?for[-\s]?age|length[-\s]?for[-\s]?age|head\s*circumference)\b/.test(combinedText)
    // "growth" + datastore/config wording is plugin setup too — "set up the
    // child growth data store" (verified miss 2026-07-10) previously routed to
    // generic dataStore writes because this trigger lacked the datastore nouns.
    || (/\bgrowth\b/.test(combinedText) && /\b(plugin|chart|standard|percentile|z-?score|data\s*store|datastore)\b/.test(combinedText));
  // ── Validation-rule intent ──
  // "validation rule(s)", or a data-quality/consistency/plausibility check that
  // co-occurs with rule/check/dataset/data-element terms. Conservative: the bare
  // word "validate" only triggers alongside an aggregate-data noun, so unrelated
  // "validate this expression / form" turns don't surface the tool.
  const wantsValidationRuleIntent =
    /\bvalidation\s*rules?\b/.test(combinedText)
    || (/\b(data\s*quality|consistency|cross[-\s]?check|plausibility|sanity\s*check)\b/.test(combinedText)
        && /\b(rule|check|validat|dataset|data\s*set|data\s*element|aggregate|expression)\b/.test(combinedText))
    || (/\bvalidat(e|ion)\b/.test(combinedText)
        && /\b(left\s*side|right\s*side|leftside|rightside|compulsory\s*pair|exclusive\s*pair|greater\s*than|less\s*than|data\s*set|dataset|aggregate\s*data)\b/.test(combinedText));
  // ── Org-unit (hierarchy) intent ──
  // Explicit "org/organisation unit(s)" or "OU/org hierarchy/tree" terms, OR a
  // management verb on a facility/chiefdom noun, optionally preceded by
  // determiners/quantifiers (a/the/new/several/"three"/"5", singular OR plural
  // facility|clinic|hospital|…), with at most ONE free intervening word — so
  // "register three new health facilities" and "close 2 clinics" DO match while
  // "create a chart for the facility" does NOT — OR a facility noun coupled with a
  // hierarchy/parent/re-parent term. Conservative on purpose: bare "facility"/
  // "district" in an analytics question never surfaces the tool.
  const wantsOrgUnitIntent =
    /\b(organi[sz]ation\s*units?|org\s*units?|orgunits?|sub-?units?)\b/.test(combinedText)
    || /\b(ou|org|organi[sz]ation)\s*(?:hierarch|tree)/.test(combinedText)
    || /\b(create|add|register|build|set\s*up|rename|re-?name|move|relocate|re-?parent|delete|remove|deactivate|close|reopen)\s+(?:a\s+|an\s+|the\s+|new\s+|this\s+|that\s+|some\s+|several\s+|multiple\s+|\d+\s+|(?:one|two|three|four|five|six|seven|eight|nine|ten)\s+)*(?:\w+\s+){0,1}(facilit(?:y|ies)|health\s*facilit(?:y|ies)?|clinics?|hospitals?|chiefdoms?|catchment\s*areas?|sub[-\s]?districts?)\b/.test(combinedText)
    || /\b(facilit(?:y|ies)|health\s*facilit(?:y|ies)?|chiefdom|catchment\s*area)\b[^.?!]{0,30}\b(hierarch|parent\s*org|sub[-\s]?unit|org\s*unit|move.{0,12}under|re-?parent)\b/.test(combinedText);
  // ── Aggregate-indicator intent ──
  // Aggregate indicators = (numerator / denominator) × factor, surfaced in
  // dashboards/pivots/maps. Conservative AND disjoint from program (tracker)
  // indicators: a turn that mentions "program indicator(s)" never matches here,
  // so manage_indicators can never steal a manage_program_indicators turn.
  // Fires on an explicit aggregate signal (aggregate indicator / indicator
  // type / numerator / denominator) OR "indicator" coupled with an authoring /
  // aggregate-analytics term.
  const mentionsProgramIndicator = /\bprogram\s+indicators?\b/.test(combinedText);
  const wantsIndicatorIntent =
    !mentionsProgramIndicator && (
      /\baggregate\s+indicators?\b/.test(combinedText)
      || /\bindicator\s*types?\b/.test(combinedText)
      || /\b(numerator|denominator)\b/.test(combinedText)
      || (/\bindicators?\b/.test(combinedText)
          && /\b(create|add|build|make|define|set\s*up|edit|update|modify|rename|delete|remove|coverage|per\s*cent|percentage|reporting\s*rate|rate|ratio|formula|factor)\b/.test(combinedText)));
  // ── Option-set intent ──
  // Reusable code/label pick-lists. Conservative: fires on an explicit
  // "option set(s)" / "optionset(s)" mention, OR a membership-mutation verb on
  // "option(s)" coupled with a drop-down / code-list / "to the set" container
  // term — so a bare "what options do I have" never surfaces the tool.
  const wantsOptionSetIntent =
    /\boption\s*sets?\b/.test(combinedText)
    || /\boptionsets?\b/.test(combinedText)
    || (/\b(add|append|remove|delete|drop|reorder|re-?order)\b/.test(combinedText)
        && /\boptions?\b/.test(combinedText)
        && (/\b(drop[\s-]?down|pick[\s-]?list|picklist|code\s*list|choices?\s+list)\b/.test(combinedText)
            || /\b(?:the|this|that)\s+(?:[\w-]+\s+){0,2}set\b/.test(combinedText)));
  // ── Legend-set intent ──
  // Reusable colour-coded value bands for analytics styling. Conservative:
  // fires on an explicit "legend set(s)" mention, OR a colour-coding / threshold
  // term coupled with an authoring or visual-styling noun — so a bare "the chart
  // legend" or "the legend of the map" never surfaces the tool on its own.
  const wantsLegendSetIntent =
    /\blegend\s*sets?\b/.test(combinedText)
    || /\blegendsets?\b/.test(combinedText)
    || ((/\bcolou?r[-\s]?cod/.test(combinedText)
          || /\bcolou?r\s+(?:band|scale|ramp|range|gradient)s?\b/.test(combinedText)
          || /\b(?:value\s+)?thresholds?\b/.test(combinedText))
        && /\b(create|add|build|make|define|set\s*up|configure|legend|map|visuali[sz]ation|indicator|data\s*element)\b/.test(combinedText))
    // The word "legend" coupled with an explicit colour-scale signal — so
    // "give it a traffic-light legend", "a red/amber/green legend", "a
    // colour-coded legend", "a heat-map legend" all surface the tool, while a
    // bare "the chart/map legend" (no colour-scale intent) stays FALSE.
    || (/\blegends?\b/.test(combinedText)
        && (/\btraffic[-\s]?light/.test(combinedText)
            || /\bheat[-\s]?map/.test(combinedText)
            || /\bcolou?r[-\s]?cod/.test(combinedText)
            || /\b(?:value\s+)?thresholds?\b/.test(combinedText)
            || /\bred\b[-\s\/,]*(?:to\s+)?(?:amber|orange|yellow)\b[-\s\/,]*(?:to\s+)?\bgreen\b/.test(combinedText)
            || /\bgreen\b[-\s\/,]*(?:to\s+)?(?:amber|orange|yellow)\b[-\s\/,]*(?:to\s+)?\bred\b/.test(combinedText)));
  // ── Dashboard / visualization authoring intent ──
  // Reusable analytics dashboards and the charts/pivots/single-value tiles on
  // them. Conservative AND disjoint from render_chart (the inline preview tool):
  // fires on an explicit "dashboard" mention, OR a PERSISTENCE verb (create /
  // build / make / save / design / set up) coupled with a saved-visualization
  // noun (visualization / pivot table / single value / gauge / saved chart) —
  // so "show me a chart" / "plot this" stays with render_chart and never
  // surfaces this tool. Being on the Dashboard app also surfaces it.
  const wantsDashboardIntent =
    /\bdashboards?\b/.test(combinedText)
    || (/\b(create|build|make|save|design|set\s*up|setup|add|new|assemble|put\s*together)\b/.test(combinedText)
        && (/\bvisuali[sz]ations?\b/.test(combinedText)
            || /\bpivot\s*tables?\b/.test(combinedText)
            || /\bsingle[-\s]?value\b/.test(combinedText)
            || /\bgauge\s*(chart|visuali[sz]ation)?\b/.test(combinedText)
            || /\b(saved|reusable|favou?rite)\s+(chart|graph|visuali[sz]ation|pivot)\b/.test(combinedText)));
  // Map AUTHORING intent — creating a thematic (choropleth/bubble) map, or a map
  // to place on a dashboard. Constrained to an authoring verb / thematic keyword
  // (or the Maps app) so plain words like "roadmap"/"heat map"/"map out" don't
  // trip it. Reads ("explain this map") stay with get_map_details.
  const wantsMapIntent =
    (/\bmaps?\b/.test(combinedText)
      && (/\b(create|build|make|save|design|set\s*up|setup|add|new|choropleth|bubble|thematic|shade[ds]?|colou?r[- ]?cod)\b/.test(combinedText)))
    || /\bchoropleth\b/.test(combinedText)
    || /\bthematic\s+maps?\b/.test(combinedText);
  // ── Line-list authoring intent ──
  // Saved row-per-record tables (Line Listing app / eventVisualizations of
  // type LINE_LIST). Fires on explicit "line list(ing)" wording, on classic
  // implementor phrasings ("case register", "patient listing", "listing of
  // enrollments"), or on an authoring verb + row-level-table noun. Reads like
  // "how do I use the Line Listing app" also match — the tool's list/get/
  // validate actions are read-only and line_listing_guide travels alongside
  // when the user is IN the app.
  const wantsLineListIntent =
    /\bline[-\s]?list(?:s|ing|ings)?\b/.test(combinedText)
    || /\bevent\s*visuali[sz]ations?\b/.test(combinedText)
    || /\b(case|patient|client|person|tei|entity|enrollment|event|cohort|treatment|defaulter|follow[-\s]?up)\s+(register|registry|listing)\b/.test(combinedText)
    || (/\b(register|listing|row[-\s]?level|record[-\s]?level)\b/.test(combinedText)
        && /\b(tracker|program|stage|enrollment|event|patient|case|cohort)\b/.test(combinedText)
        && /\b(create|build|make|design|set\s*up|save|generate|author|update|list)\b/.test(combinedText));
  const wantsAuthoring = wantsCreateIntent || wantsManageIntent;
  // Bounded gap: up to 3 words between keywords so we catch "fix the broken rule" without false-matching on
  // unrelated text that happens to contain both "rule" and "issue" paragraphs apart.
  const RULE_GAP = '(?:\\s+\\w+){0,3}\\s+';
  const wantsProgramRulesIntent = new RegExp(
    '\\b(?:program rules?|rule condition|rule action|showwarning|showerror|hidefield|assign action|setmandatory'
    + '|audit rules?|check rules?|broken rules?|rule issue|rule problem|not working rules?'
    + `|rules?${RULE_GAP}(?:issue|broken|not working|fail(?:ing|ed)?)`
    + `|(?:fix|find|repair|debug)${RULE_GAP}rules?)\\b`
  ).test(combinedText);
  const wantsProgramIndicatorsIntent = new RegExp(
    '\\b(?:program indicators?|indicator expression|indicator filter'
    + '|audit indicators?|check indicators?|broken indicators?|indicator issue|indicator problem|not working indicators?'
    + `|indicators?${RULE_GAP}(?:issue|broken|not working|fail(?:ing|ed)?)`
    + `|(?:fix|find|repair|debug)${RULE_GAP}indicators?`
    // Discovery phrasings — "complex/heavy/biggest/top/most/longest/advanced/sophisticated/complicated indicators"
    + '|(?:complex|complicated|advanced|sophisticated|heavy|heaviest|big|biggest|largest|longest|top|most|hardest|richest)'
    + `${RULE_GAP}(?:program ?)?indicators?`
    + '|indicators?\\s+(?:with|that have|that has|having)\\s+(?:a lot|lots|most|lots? of|many|complex|complicated|long|heavy|big|biggest|the most)'
    // rank_ou phrasings — "which OUs/districts/regions/facilities have the most data/events for these indicators/programs"
    + '|(?:which|what|top)\\s+(?:ous?|org ?units?|districts?|regions?|facilities|facility|provinces?|countries|sites?|health ?facilities)'
    + '|(?:ous?|org ?units?|districts?|regions?|facilities|facility|provinces?|sites?)\\s+(?:with|having|that have|that has)\\s+(?:the most|most|a lot|lots|many|highest|largest))\\b'
  ).test(combinedText);
  const hasInspectRuleErrors = !!inspectSnapshot?.insights?.rule_errors?.length;
  const hasInspectNetworkErrors = !!inspectSnapshot?.insights?.network_errors?.length;

  // ── Save-failure diagnostic intent ──
  // Triggered by phrasings like "error saving enrollment", "can't save",
  // "failed to save", "409 conflict", or a 409 visible in inspect logs.
  // When detected AND the user has NOT authorized writes this turn, we hide
  // every destructive tool from the model — the model can read everything to
  // diagnose, but cannot "fix" until the user gives explicit authorization on
  // a later turn. This blocks the failure mode where the model edited program
  // rules in response to a save error that had nothing to do with rules.
  const hasInspect409 = !!inspectSnapshot?.insights?.network_errors?.some(e => Number(e.status) === 409);
  const wantsSaveErrorDiagnosis = SAVE_FAILURE_RE.test(combinedText) || hasInspect409;
  const writeAuthScope = (dhis2.writeAuth && dhis2.writeAuth.scope) || 'read_only';
  const saveDiagnosisReadOnly = wantsSaveErrorDiagnosis && writeAuthScope === 'read_only';

  // ── Factual context flags — derived from URL/app state only, no NLU ──
  const hasProgram    = !!ctx?.programId;
  const hasTei        = !!ctx?.teiId;
  const hasViz        = !!(ctx?.visualizationId && appType === 'Data Visualizer');
  const hasMap        = !!(ctx?.mapId && appType === 'Maps');
  const hasDataset    = !!ctx?.datasetId;
  const isLineListing = appType === 'Line Listing';
  const isTrackerApp  = ['Capture', 'Tracker Capture'].includes(appType);
  const isMaintenance = appType === 'Maintenance';
  const isDashboard   = appType === 'Dashboard';
  const isDataViz     = appType === 'Data Visualizer';
  const isMaps        = appType === 'Maps';
  const isAggDataEntry = ['Data Entry', 'Aggregate Data Entry', 'Dataset Report', 'Reporting'].includes(appType);
  const inTrackerCtx  = hasProgram || isTrackerApp || isLineListing;
  const inDatasetCtx  = hasDataset || isAggDataEntry;

  // Minimal core — only the universal API fallback and search
  const selected = new Set([
    'dhis2_query',     // universal API fallback — always present
    'search_metadata', // always useful for UID/name/code lookups
  ]);

  if (wantsProgramChangeHistory || hasProgram || isMaintenance) {
    selected.add('get_program_recent_changes');
  }

  // ── Data-oriented tools — only on pages where data analysis is relevant ──
  if (!isMaintenance) {
    selected.add('render_chart');
    selected.add('count_records');
  }

  // ── Visualization — only when a concrete visualization is in context ──
  if (hasViz) selected.add('get_visualization_details');

  // ── Map — only when a concrete map is in context ──
  if (hasMap) selected.add('get_map_details');

  // ── TEI in context ──
  // Patient/TEI lookup is disabled (no get_tracked_entity tool); resolve_option_codes
  // is still useful for any aggregate/program-level data the user asks about.
  if (hasTei) {
    selected.add('resolve_option_codes');
  }

  // ── Line Listing app ──
  if (isLineListing) {
    selected.add('line_listing_guide');
    selected.add('detect_enrollment_abnormalities');
    selected.add('resolve_option_codes');
  }

  // ── Line-list authoring — saved Line Listing tables ──
  // Surfaced on explicit line-list intent, or whenever the user is IN the
  // Line Listing app (where "save this as…", "make me a register of…" are the
  // obvious next steps). Companions: get_program_info + search_metadata for
  // dimension resolution, manage_program_indicators for the row-level metric
  // columns, manage_legend_sets for colour-coding, manage_dashboards for
  // placement — the canonical register workflow chains all four.
  if (wantsLineListIntent || isLineListing) {
    selected.add('manage_line_lists');
    selected.add('get_program_info');
    selected.add('search_metadata');
    if (wantsLineListIntent) {
      selected.add('manage_program_indicators');
      selected.add('manage_legend_sets');
      selected.add('manage_dashboards');
    }
  }

  // ── Tracker / program context ──
  if (inTrackerCtx) {
    selected.add('get_event_analytics');
    selected.add('get_program_info');
    selected.add('resolve_option_codes');
    selected.add('detect_enrollment_abnormalities');
    selected.add('cross_stage_entity_intersection');
    selected.add('manage_program_rules');
    selected.add('manage_program_indicators');
    selected.add('create_metadata');
    selected.add('architect_metadata');
    selected.add('manage_metadata');
  }

  // ── Maintenance / Dashboard / other non-tracker pages: authoring tools only ──
  if (!inTrackerCtx && !isDataViz && !isMaps) {
    selected.add('get_program_info');
    selected.add('create_metadata');
    selected.add('architect_metadata');
    selected.add('manage_metadata');
    // Only include rule/indicator tools when on maintenance (where programs are managed)
    if (isMaintenance) {
      selected.add('manage_program_rules');
      selected.add('manage_program_indicators');
    }
  }

  // ── Dataset / Aggregate-data context ──
  // Active whenever the user is on a data-entry or dataset-report page, has a
  // dataset UID in URL, or explicitly mentions datasets / aggregate data /
  // category combinations / period types. manage_datasets is the dedicated
  // CRUD tool; we also surface manage_metadata (delete/sharing/style apply
  // to dataSets too) and search_metadata for DE/OU/categoryCombo lookups
  // during create.
  if (inDatasetCtx || wantsDatasetIntent) {
    selected.add('manage_datasets');
    selected.add('manage_metadata');
    selected.add('manage_custom_forms');
    selected.add('search_metadata');
    selected.add('get_program_info');
    // Resolve_option_codes is useful for cat-combo / option labels in saved values
    if (inDatasetCtx) selected.add('resolve_option_codes');
  }

  // ── Custom-form authoring — dataset OR program-stage HTML forms ──
  // Surface manage_custom_forms whenever the user expresses form-design intent,
  // or is in a tracker/dataset context where a custom form is plausible.
  if (wantsCustomFormIntent || inTrackerCtx) {
    selected.add('manage_custom_forms');
    selected.add('get_program_info');
    selected.add('search_metadata');
  }

  // ── Custom-translation authoring — app UI string translation / re-labelling ──
  // App-agnostic: surface whenever the user expresses translation/relabel intent.
  if (wantsTranslationIntent) {
    selected.add('manage_custom_translations');
  }

  // ── Growth-chart plugin setup — install + datastore config for the WHO chart ──
  if (wantsGrowthChartIntent) {
    selected.add('manage_growth_chart_plugin');
    selected.add('get_program_info');
    selected.add('search_metadata');
  }

  // ── Validation-rule authoring — surfaced only on explicit validation-rule
  //    intent so it never crowds unrelated dataset/tracker flows. search_metadata
  //    is the companion for resolving the data-element UIDs the expressions need. ──
  if (wantsValidationRuleIntent) {
    selected.add('manage_validation_rules');
    selected.add('search_metadata');
  }

  // ── Org-unit hierarchy authoring — surfaced only on explicit org-unit intent
  //    so it never crowds unrelated analytics/dataset/tracker flows. search_metadata
  //    is the companion for resolving parent / target OU UIDs. ──
  if (wantsOrgUnitIntent) {
    selected.add('manage_org_units');
    selected.add('search_metadata');
  }

  // ── Aggregate-indicator authoring — surfaced only on explicit, program-
  //    indicator-disjoint aggregate-indicator intent so it never crowds
  //    unrelated analytics/tracker flows. search_metadata is the companion for
  //    resolving the dataElement / dataSet / programIndicator UIDs the
  //    numerator/denominator expressions need. ──
  if (wantsIndicatorIntent) {
    selected.add('manage_indicators');
    selected.add('search_metadata');
  }

  // ── Option-set authoring — surfaced only on explicit option-set intent so it
  //    never crowds unrelated flows. search_metadata is the companion for
  //    resolving the set / option UIDs the membership ops need. Purely additive:
  //    create_metadata's inline option_set path is unaffected. ──
  if (wantsOptionSetIntent) {
    selected.add('manage_option_sets');
    selected.add('search_metadata');
  }

  // ── Legend-set authoring — surfaced only on explicit legend-set intent so it
  //    never crowds unrelated analytics/styling flows. search_metadata is the
  //    companion for resolving the dataElement / indicator UIDs a legend set is
  //    later attached to. Purely additive. ──
  if (wantsLegendSetIntent) {
    selected.add('manage_legend_sets');
    selected.add('search_metadata');
  }

  // ── Thematic map authoring — surfaced on explicit map-creation intent or when
  //    the user is in the Maps app. search_metadata resolves the data item /
  //    OU UIDs; legend sets pair naturally with choropleth colour bands. ──
  if (wantsMapIntent || isMaps) {
    selected.add('manage_maps');
    selected.add('search_metadata');
    selected.add('manage_legend_sets');
  }

  // ── Dashboard / visualization authoring — surfaced on explicit dashboard /
  //    saved-visualization intent, OR whenever the user is on the Dashboard or
  //    Data Visualizer app (where building/saving a chart or dashboard is the
  //    obvious next step). search_metadata is the companion for resolving the
  //    indicator / dataElement / programIndicator / OU UIDs the charts plot.
  //    render_chart stays in the set, so inline-preview turns are unaffected. ──
  if (wantsDashboardIntent || isDashboard || isDataViz) {
    selected.add('manage_dashboards');
    selected.add('search_metadata');
    // Maps commonly ride onto dashboards ("…and a map of X by district"), so the
    // map authoring tool travels with dashboard intent too.
    selected.add('manage_maps');
    // A chart/dashboard plots INDICATORS. "Replace this tile with one showing
    // <a metric that doesn't exist yet>" is a routine dashboard request, and the
    // model must be able to CREATE the data item the new chart needs — otherwise
    // it has manage_dashboards but no way to build the metric and loops (the
    // "percentage of males vs females enrolled" disaster, 2026-07-13, where a
    // typo'd "incdicator" also defeated every indicator keyword). Surface BOTH
    // indicator managers (the model picks the right one from their descriptions:
    // tracker/enrollment metrics → manage_program_indicators, aggregate ratios →
    // manage_indicators) plus get_program_info to inspect the program's stages/
    // attributes the program-indicator expression references. These are slim
    // MANUAL_TOOLS summaries on the wire, so the token cost is negligible.
    selected.add('manage_program_indicators');
    selected.add('manage_indicators');
    selected.add('get_program_info');
    // Dashboard/visualization SHARING and DELETION live in manage_metadata
    // (manage_dashboards only CREATES and READS). The canonical multi-step
    // dashboard goal ends in a "share it" / "make it public" step, so the
    // sharing tool must travel with explicit dashboard/visualization authoring
    // intent — otherwise that final step has no tool and the model falls back
    // to a raw dhis2_query PUT that DHIS2 rejects. Gated on the explicit text
    // intent (NOT bare isDataViz/isDashboard) so pure analytics turns add no
    // destructive tool; on the Dashboard app manage_metadata is already
    // surfaced by the non-tracker authoring block above.
    if (wantsDashboardIntent) selected.add('manage_metadata');
  }

  // ── Intent-driven override: if the user explicitly asks to create or manage
  //    metadata, the full authoring kit must be available regardless of page.
  //    This fixes the failure mode where a user on Data Visualizer / Maps / a
  //    dashboard types "create a tracker program" and the model has no
  //    create_metadata tool, so it falls back to manual dhis2_query loops. ──
  if (wantsAuthoring) {
    selected.add('create_metadata');
    selected.add('architect_metadata');
    selected.add('manage_metadata');
    selected.add('get_program_info');
    selected.add('manage_program_rules');
    selected.add('manage_program_indicators');
    // Datasets are first-class metadata too — "create a dataset" / "make an
    // aggregate form" must resolve through the dedicated tool, not raw POSTs.
    if (wantsDatasetIntent || inDatasetCtx) selected.add('manage_datasets');
  }
  if (wantsSharingIntent) {
    selected.add('manage_metadata');
  }
  if (wantsIconStyleIntent) {
    selected.add('manage_metadata');
    selected.add('dhis2_query'); // for browsing /icons?search=... when needed
  }

  // If the user mentions program rules or indicators, always expose the managers
  // (including their audit / bulk_fix actions) regardless of page context.
  if (wantsProgramRulesIntent) {
    selected.add('manage_program_rules');
    selected.add('get_program_info');
  }
  if (wantsProgramIndicatorsIntent) {
    selected.add('manage_program_indicators');
    selected.add('get_program_info');
  }
  if (wantsNotificationsIntent) {
    selected.add('manage_program_notifications');
    selected.add('get_program_info');
  }
  // manage_backups is included whenever the user mentions backup/restore/undo
  // OR whenever any other write-capable tool is in the selection — that way
  // the model can always tell the user "the backup key is X" after a write.
  const writeCapableNames = new Set([
    'manage_metadata', 'manage_program_rules', 'manage_program_indicators',
    'manage_program_notifications', 'create_metadata', 'manage_datasets',
    'manage_custom_forms', 'manage_validation_rules', 'manage_org_units',
    'manage_indicators', 'manage_option_sets', 'manage_legend_sets',
    'manage_dashboards', 'manage_maps', 'manage_line_lists',
  ]);
  let hasWriteTool = false;
  for (const n of selected) { if (writeCapableNames.has(n)) { hasWriteTool = true; break; } }
  if (wantsBackupIntent || hasWriteTool) {
    selected.add('manage_backups');
  }

  if (inspectSnapshot?.enabled) {
    selected.add('dhis2_query');
    selected.add('search_metadata');
    selected.add('get_program_info');
    if (hasInspectRuleErrors) {
      selected.add('manage_program_rules');
      selected.add('manage_program_indicators');
    }
    if (hasInspectNetworkErrors || hasInspectRuleErrors) {
      selected.add('resolve_option_codes');
    }
  }

  // ── Web browsing ──
  if (browseWeb) selected.add('browse_web');

  // ── Save-failure diagnostic mode: strip destructive tools until the user
  //    explicitly authorizes a fix on a future turn. Read-only tools stay so
  //    the model can fully investigate. ──
  if (saveDiagnosisReadOnly) {
    selected.delete('manage_program_rules');
    selected.delete('manage_program_indicators');
    selected.delete('manage_metadata');
    selected.delete('manage_program_notifications');
    selected.delete('create_metadata');
    selected.delete('manage_datasets');
    selected.delete('manage_custom_forms');
    selected.delete('manage_validation_rules');
    selected.delete('manage_org_units');
    selected.delete('manage_indicators');
    selected.delete('manage_option_sets');
    selected.delete('manage_legend_sets');
    selected.delete('manage_dashboards');
    selected.delete('manage_maps');
    selected.delete('manage_line_lists');
    // Keep architect_metadata (read-only research) and manage_backups (list/get
    // are read-only — the executor itself gates restore/delete/purge_old).
  }

  return TOOLS.filter(t => selected.has(t.function.name));
}

// ── System Prompt Builder ────────────────────────────────────────────────────

async function buildSystemPrompt(userText = '', hasImage = false, browseWeb = false, inspectSnapshot = null) {
  const ctx = dhis2.pageContext || {};
  const ou = dhis2.ouContext;
  const prog = dhis2.programMetadata;

  // Intent detection — used to conditionally include sections
  const inspectIntentText = inspectSnapshot?.enabled ? JSON.stringify(inspectSnapshot.insights || {}).toLowerCase() : '';
  const text = `${(userText || '').toLowerCase()}\n${inspectIntentText}`;
  const isCreating  = /\b(create|build|design|new program|set up a program|make a program)\b/.test(text)
    || /\badd\b.{0,50}\b(data elements?|fields?|stages?|rules?|option sets?)\b/.test(text)
    || /\b(add|assign)\b.{1,80}\bto\b.{1,50}\bstage\b/.test(text);
  const PROMPT_GAP = '(?:\\s+\\w+){0,3}\\s+';
  const wantsProgramRulesPrompt = new RegExp(
    '\\b(?:program rules?|rule condition|rule action|showwarning|showerror|hidefield|assign action|setmandatory'
    + '|list rules?|modify rules?|update rules?|delete rules?|create rules?'
    + '|audit rules?|check rules?|broken rules?|rule issue|rule problem|not working rules?'
    + `|rules?${PROMPT_GAP}(?:issue|broken|not working|fail(?:ing|ed)?)`
    + `|(?:fix|find|repair|debug)${PROMPT_GAP}rules?)\\b`
  ).test(text);
  const wantsProgramIndicatorsPrompt = new RegExp(
    '\\b(?:program indicators?|indicator expression|indicator filter'
    + '|create indicators?|update indicators?|modify indicators?|list indicators?|delete indicators?'
    + '|audit indicators?|check indicators?|broken indicators?|indicator issue|indicator problem|not working indicators?'
    + `|indicators?${PROMPT_GAP}(?:issue|broken|not working|fail(?:ing|ed)?)`
    + `|(?:fix|find|repair|debug)${PROMPT_GAP}indicators?)\\b`
  ).test(text);
  const wantsProgramChangesPrompt = /\b(recent changes|what changed|changes made|change history|history of changes|recent modifications|modified in the last|updated in the last|changes in the last)\b/.test(text);
  const wantsMetadataMgmt = /\b(delete|remove|drop|detach|unassign|clean up)\b.{0,80}\b(data element|field|stage|option set|attribute|metadata|from.{0,30}(program|stage))\b/i.test(text)
    || /\b(data element|field|option set|attribute)\b.{0,80}\b(delete|remove|drop)\b/i.test(text)
    // Value-type conversions ("change/convert/switch type to multi-select / text with multiple values")
    || /\b(change|convert|switch|make|turn|flip|set)\b.{0,60}\b(value\s*type|type|to)\b.{0,60}\b(multi[- ]?text|multi[- ]?select|multiple\s*(values?|selections?)|text\s*with\s*multiple)\b/i.test(text)
    || /\b(multi[- ]?select|multi[- ]?text|text\s*with\s*multiple\s*values?|multiple\s*selections?)\b/i.test(text);
  const wantsSharingAccess = /\b(sharing|access|permission|can'?t see|not visible|not showing|doesn'?t appear|doesn'?t show|don'?t see|missing from|hidden|no access|data access|publicAccess|public access|user group access)\b/i.test(text)
    || /\b(capture|data entry|tracker).{0,60}\b(not|doesn'?t|can'?t|missing|hidden|don'?t)\b/i.test(text)
    || /\b(not|doesn'?t|can'?t|missing|hidden|don'?t).{0,60}\b(capture|data entry|tracker|drop.?down|dropdown|list)\b/i.test(text)
    || /\b(fix|update|change|set|grant|give|enable)\b.{0,40}\b(sharing|access|permission|visibility)\b/i.test(text)
    || /\b(make|set|mark|publish|share)\b.{0,30}\bpublic(ly)?\b/i.test(text)
    || /\bshare[ds]?\b.{0,40}\bwith\b.{0,40}\b(everyone|all\s+users|the\s+public|user\s*group|team|colleagues?)\b/i.test(text);
  const wantsIconStyle = /\b(icon|style)\b/i.test(text) && /\b(program|stage|data ?element|option set|attribute|tea|indicator)\b/i.test(text)
    || /\b(give|set|assign|change|update|pick|choose|add)\b.{0,25}\b(icon|style|color|colour)\b/i.test(text)
    || /\b(icon|style|color|colour)\b.{0,40}\b(for|to|on)\b.{0,40}\b(program|stage|data ?element|option set|attribute|indicator)\b/i.test(text);
  const wantsNotificationsPrompt =
    /\b(program notifications?|notification templates?|webhooks?|web[- ]?hook)\b/i.test(text)
    || (/\b(notify|notification|alert|message)\b/i.test(text)
        && /\b(on enrollment|on completion|when enrolled|when completed|program rule|scheduled|due date|incident date|enrollment date)\b/i.test(text))
    || /\b(send|post).{0,40}\b(webhook|notification|to.{0,10}url|to.{0,10}endpoint)\b/i.test(text);
  const wantsChart  = /\b(chart|graph|plot|visualize|visualise)\b/.test(text);
  const hasVizCtx   = ctx.appType === 'Data Visualizer';
  const hasMapCtx   = ctx.appType === 'Maps';
  const hasTeiCtx   = !!ctx.teiId;
  const inTrackerCtx = !!(ctx.programId || ['Capture', 'Tracker Capture'].includes(ctx.appType) || ctx.appType === 'Line Listing');
  const hasDatasetCtx = !!ctx.datasetId;
  const inAggDataEntryCtx = ['Data Entry', 'Aggregate Data Entry', 'Dataset Report', 'Reporting'].includes(ctx.appType);
  const wantsDatasetPrompt = /\b(data\s*sets?|datasets?)\b/i.test(text)
    || /\b(aggregate|aggregated)\b.{0,40}\b(program|programme|data|form|entry|reporting|report)\b/i.test(text)
    || /\b(data\s*entry|aggregate\s*data\s*entry|entry\s*form|reporting\s*form|aggregate\s*form)\b/i.test(text)
    || /\b(period\s*type|monthly\s*form|weekly\s*form|quarterly\s*form|yearly\s*form)\b/i.test(text)
    || /\b(category\s*combo|category\s*combination|disaggregation|cat\s*combo)\b/i.test(text);
  const wantsTrackerWrite = inTrackerCtx && /\b(create|add|register|enroll|complete|close|update|change status|new enrollment|new profile|new event|mark.{0,20}complete|set.{0,20}complete)\b/i.test(text);
  const wantsCustomFormPrompt =
    /\b(custom\s*forms?|custom\s*(data\s*)?entry\s*forms?|custom\s*layout|html\s*forms?|form\s*designer|dataentryform)\b/i.test(text)
    || (/\b(design|build|create|make|lay\s*out|customi[sz]e)\b.{0,40}\b(form|layout)\b/i.test(text)
        && /\b(custom|html|data\s*entry|tracker|stage|dataset|data\s*set|aggregate)\b/i.test(text));
  const wantsTranslationPrompt =
    /\b(custom\s*translations?|translate|translations?|localis[ez]e|localiz[ae]tion)\b/i.test(text)
    || /\b(re-?label|re-?name|change|reword|customi[sz]e)\b.{0,40}\b(label|string|text|wording|caption|button|title|heading|menu\s*item)\b/i.test(text);
  const wantsGrowthChartPrompt =
    /\b(growth\s*chart|growth\s*monitoring|who\s*growth|anthropomet|weight[-\s]?for[-\s]?age|height[-\s]?for[-\s]?age|length[-\s]?for[-\s]?age|head\s*circumference)\b/i.test(text)
    || (/\bgrowth\b/i.test(text) && /\b(plugin|chart|standard|percentile|z-?score|data\s*store|datastore)\b/i.test(text));
  const wantsValidationRulePrompt =
    /\bvalidation\s*rules?\b/i.test(text)
    || (/\b(data\s*quality|consistency|cross[-\s]?check|plausibility|sanity\s*check)\b/i.test(text)
        && /\b(rule|check|validat|dataset|data\s*set|data\s*element|aggregate|expression)\b/i.test(text))
    || (/\bvalidat(e|ion)\b/i.test(text)
        && /\b(left\s*side|right\s*side|leftside|rightside|compulsory\s*pair|exclusive\s*pair|greater\s*than|less\s*than|data\s*set|dataset|aggregate\s*data)\b/i.test(text));
  const wantsOrgUnitPrompt =
    /\b(organi[sz]ation\s*units?|org\s*units?|orgunits?|sub-?units?)\b/i.test(text)
    || /\b(ou|org|organi[sz]ation)\s*(?:hierarch|tree)/i.test(text)
    || /\b(create|add|register|build|set\s*up|rename|re-?name|move|relocate|re-?parent|delete|remove|deactivate|close|reopen)\s+(?:a\s+|an\s+|the\s+|new\s+|this\s+|that\s+|some\s+|several\s+|multiple\s+|\d+\s+|(?:one|two|three|four|five|six|seven|eight|nine|ten)\s+)*(?:\w+\s+){0,1}(facilit(?:y|ies)|health\s*facilit(?:y|ies)?|clinics?|hospitals?|chiefdoms?|catchment\s*areas?|sub[-\s]?districts?)\b/i.test(text)
    || /\b(facilit(?:y|ies)|health\s*facilit(?:y|ies)?|chiefdom|catchment\s*area)\b[^.?!]{0,30}\b(hierarch|parent\s*org|sub[-\s]?unit|org\s*unit|move.{0,12}under|re-?parent)\b/i.test(text);
  const wantsIndicatorPrompt =
    !/\bprogram\s+indicators?\b/i.test(text) && (
      /\baggregate\s+indicators?\b/i.test(text)
      || /\bindicator\s*types?\b/i.test(text)
      || /\b(numerator|denominator)\b/i.test(text)
      || (/\bindicators?\b/i.test(text)
          && /\b(create|add|build|make|define|set\s*up|edit|update|modify|rename|delete|remove|coverage|per\s*cent|percentage|reporting\s*rate|rate|ratio|formula|factor)\b/i.test(text)));
  const wantsOptionSetPrompt =
    /\boption\s*sets?\b/i.test(text)
    || /\boptionsets?\b/i.test(text)
    || (/\b(add|append|remove|delete|drop|reorder|re-?order)\b/i.test(text)
        && /\boptions?\b/i.test(text)
        && (/\b(drop[\s-]?down|pick[\s-]?list|picklist|code\s*list|choices?\s+list)\b/i.test(text)
            || /\b(?:the|this|that)\s+(?:[\w-]+\s+){0,2}set\b/i.test(text)));
  const wantsLegendSetPrompt =
    /\blegend\s*sets?\b/i.test(text)
    || /\blegendsets?\b/i.test(text)
    || ((/\bcolou?r[-\s]?cod/i.test(text)
          || /\bcolou?r\s+(?:band|scale|ramp|range|gradient)s?\b/i.test(text)
          || /\b(?:value\s+)?thresholds?\b/i.test(text))
        && /\b(create|add|build|make|define|set\s*up|configure|legend|map|visuali[sz]ation|indicator|data\s*element)\b/i.test(text));

  // Dashboard / visualization authoring KB — surfaced on explicit dashboard /
  // saved-visualization intent, or whenever the user is on the Dashboard or
  // Data Visualizer app.
  const wantsDashboardPrompt =
    /\bdashboards?\b/i.test(text)
    || ctx.appType === 'Dashboard'
    || ctx.appType === 'Data Visualizer'
    || (/\b(create|build|make|save|design|set\s*up|assemble)\b/i.test(text)
        && (/\bvisuali[sz]ations?\b/i.test(text) || /\bpivot\s*tables?\b/i.test(text)
            || /\bsingle[-\s]?value\b/i.test(text) || /\b(saved|reusable|favou?rite)\s+(chart|graph|visuali[sz]ation|pivot)\b/i.test(text)));

  // Compound / multi-step authoring goal — the request needs several DEPENDENT
  // steps to finish (e.g. a dashboard whose indicators/visualizations do not
  // exist yet, or "set up a program AND its indicators AND a dashboard AND
  // sharing"). Detected when dashboard authoring co-occurs with create /
  // indicator / visualization intent, OR when an assembling verb co-occurs with
  // a chaining word and two-or-more distinct buildable nouns. Used only to add
  // the orchestration playbook below — never to remove or gate any tool.
  const _buildNouns = (text.match(/\b(programmes?|programs?|datasets?|data\s*sets?|data\s*elements?|program\s*indicators?|indicators?|visuali[sz]ations?|charts?|pivots?|dashboards?|option\s*sets?|legend\s*sets?|validation\s*rules?|org(?:anisation)?\s*units?|sharing)\b/gi) || []);
  const _distinctBuildNouns = new Set(_buildNouns.map(s => s.toLowerCase().replace(/\s+/g, ' ').replace(/s$/, '')));
  const wantsMultiStepGoal =
    // Dashboard CREATION (isCreating) that ALSO names a second buildable piece —
    // an indicator/visualization/data-element, or explicit "don't have it yet"
    // language. Both guards are required: bare "build a dashboard of X" (one
    // step, no second piece) and bare "make this visualization public" (a pure
    // sharing step, no creation) must each stay false.
    (wantsDashboardPrompt && isCreating && (wantsIndicatorPrompt
        || /\b(indicators?|visuali[sz]ations?|program\s*indicators?|data\s*elements?)\b/i.test(text)
        || /\b(don'?t|do\s*not|doesn'?t|does\s*not|not\s*yet|missing|need(s)?\s+(new|to\s+create)|that\s+don'?t\s+exist)\b/i.test(text)))
    || (/\b(build|create|make|set\s*up|setup|assemble|design)\b/i.test(text)
        && /\b(and|then|plus|including|along\s+with|as\s+well\s+as|so\s+that)\b/i.test(text)
        && _distinctBuildNouns.size >= 2);

  let p = `You are a DHIS2 Health Data AI Assistant. You answer questions about health data by querying the DHIS2 API using the tools provided.

## RULES
0. CRITICAL: ALWAYS use tool calls to complete tasks — NEVER describe what you plan to do. If the user asks for multiple things (e.g., "list X then chart it"), complete ALL steps by calling tools. After a tool returns data, call the next tool immediately — do NOT output text describing the next step.
1. NEVER ask the user which program or org unit — always use current context below.
2. NEVER show raw UIDs or codes to the user — always resolve to display names.
3. When user says "this program", "enrolled here", etc. → use current context.
3.1. CRITICAL: When user says "this stage", "current stage", "this form", or asks about data elements/order of the stage they are in → use the **Current Stage ID** from context below. NEVER confuse the Program ID with a Stage ID — they are DIFFERENT objects. Program IDs identify programs; Stage IDs identify stages within a program. If no stage is in context, list all stages and ask which one.
4. If an API call returns 400, try a different approach. Never give up after one failure.
5. For "how many" questions about enrollments, events, or tracked entities → ALWAYS use count_records first. Do NOT use dhis2_query tracker/enrollments, tracker/events, or tracker/trackedEntities for pure counts unless count_records fails.
5.1. For enrollment/event counts, default to selected facility scope (include_children=false). Use children scope only when user explicitly asks for all facilities/descendants/all org units.
5.2. For program creation/visibility questions, distinguish two different concepts:
- program.organisationUnits = which org units the program is assigned to and can be used in Capture/Tracker
- sharing/publicAccess/user group access = which users/groups have metadata/data permission
Do NOT treat OU assignment as sharing, and do NOT treat sharing as OU assignment.
6. Always include source_info when rendering charts.
7. When filtering by option values, use the option CODE, not the displayName.
8. For tracker reads, tracked entity lists use "trackedEntities", event lists use "events", and some legacy endpoints may still use "instances".
9. Keep responses concise and data-focused. Use tables and bullet points.
10. When using get_event_analytics, always provide startDate/endDate or period.
10.5. For person-level questions with AND/OR conditions across stages (e.g., "A and B"), use cross_stage_entity_intersection — it auto-expands conditions across stages from metadata.
10.6. For "what changed in this program", "recent changes", "change history", or "changes in the last N days/months" questions about program metadata, use get_program_recent_changes — do NOT manually piece this together with dhis2_query unless that tool fails.
10.7. If the user explicitly asks for "metadata logs", "audit logs", or "changelog", call get_program_recent_changes with require_real_logs=true. If the instance lacks audit/changelog endpoints, say that clearly instead of inventing logs.
10.8. For cross-program comparisons by metadata counts (for example "which program has the most program indicators", "which program has the most rules", "which program has the most stages"), use search_metadata(object_type="programs") and compare the returned size fields. Do NOT call manage_program_indicators once per program.
10.9. For cross-program questions about INDICATOR CONTENT ("complex / heavy / biggest / top / most complicated program indicators", "indicators with lots of data", "find intricate expressions", "which indicators have the most events"), ALWAYS call manage_program_indicators(action="discover"). It needs NO program_id and returns ranked results in one shot. NEVER guess a program ID and NEVER call analytics/events/aggregate/{pid} with a made-up ID — if you don't already have a program UID in context or from a prior tool result, use action="discover" or search_metadata(object_type="programs") first.
10.9.1. For "which OUs / districts / regions / facilities have the most data (or events, or values) for these indicators / programs" questions, ALWAYS call manage_program_indicators(action="rank_ou", indicator_ids=[...]) — pass the indicator_ids returned by the prior discover call. Do NOT hand-build analytics/events/query or analytics/events/aggregate URLs for this. The tool handles the OU dimension and LEVEL correctly (default level=2; pass level=3 for districts, 4 for facilities).
10.9.2. HARD RULE — UIDs are NEVER invented. Any 11-char UID you put into a tool argument MUST come from either (a) the "Current Context" section below, or (b) a prior tool result in this conversation (discover, list, search_metadata, get_program_info, etc.). If you do not have a UID, use a tool that does not need one (discover, rank_ou, search_metadata). An analytics call with a guessed UID will be refused before it hits the server.
10.9.3. HARD RULE — NAMED-TARGET FIDELITY. When the user names a specific program/dataset/object ("Using the X Tracker, create …") and your search finds NO match, that is a FULL STOP, not a licence to improvise: tell the user the named object does not exist on this instance, list the closest existing names you found, and ask whether to (a) create it, (b) build on one specific existing object, or (c) stop. NEVER silently pick "the closest match" and build the request on it — the extension refuses program-bound writes after a failed named-program search until the user decides. (If the user explicitly asked you to CREATE the named object, an empty search is expected — create it and continue.)
11. ${isLocalProvider(getProviderConfig())
  ? 'Patient-level tracker data IS available because you are running on a LOCAL model (Ollama/localhost). When the user asks about a specific person/patient, their attributes, enrollments, or visits, you MAY use detect_enrollment_abnormalities, get_event_analytics(aggregate_type="query"), and read tracker/events|enrollments|trackedEntities via dhis2_query. Handle this sensitive data responsibly and never expose more than asked.'
  : 'Patient/TEI data lookup is HARD-BLOCKED on this (remote/cloud) model — the extension refuses every patient-level tracker read IN CODE, so do NOT attempt detect_enrollment_abnormalities, get_event_analytics(aggregate_type="query"), or tracker/trackedEntities|events|enrollments reads via dhis2_query (even when a TEI ID is in the page URL); they are refused regardless of what you do. If the user asks about "this person/patient", their attributes, enrollments, or visits, explain that patient-level retrieval is permitted ONLY when the assistant runs on a local (Ollama) model, and offer program-level alternatives (count_records, get_event_analytics aggregate, get_program_info).'}
12. NEVER show option codes like "M-360-8010" or data element IDs to the user. Always show resolved display names.
13. When presenting aggregate / event analytics data, resolve any raw IDs (data element, org unit, program stage) via resolve_option_codes before showing them to the user.
14. For any data element value that looks like a code (hyphens, letters+numbers) — resolve it using resolve_option_codes before displaying.
14.1. For tracker write tasks, never invent TEI, enrollment, stage, or event IDs. Use the current context IDs exactly, or fetch them first.
14.2. Never claim a tracker create/update/delete succeeded unless the tool result shows no validation errors and stats.created/stats.updated/stats.deleted is greater than 0.
15. For sharing/access issues (program not appearing, "can't see", no data access): check the access field first, then use manage_metadata(action=update_sharing) to fix. NEVER use dhis2_query PUT/PATCH for sharing — it will fail.
16. Two-tier tool docs: authoring/write tools carry a short routing description; their FULL usage manual is delivered automatically as the result of your FIRST call to them each turn (that first call does not execute — it is not an error). When you receive a manual, read it, then immediately re-issue the corrected tool call. Never tell the user about manuals or this mechanism.
`;

  // ── Tracker Write Protocol — only when user wants to create/update/complete tracker data ──
  if (wantsTrackerWrite) {
    p += `
## Tracker Write Protocol

### Creating enrollment WITH events (single call)
Nest events inside the enrollment — creates everything atomically:
\`\`\`
POST tracker?async=false&importStrategy=CREATE
{
  "enrollments": [{
    "trackedEntity": "<teiId>",
    "program": "<programId>",
    "orgUnit": "<orgUnitId>",
    "enrolledAt": "YYYY-MM-DD",
    "occurredAt": "YYYY-MM-DD",
    "status": "COMPLETED",
    "events": [{
      "programStage": "<stageId>",
      "orgUnit": "<orgUnitId>",
      "occurredAt": "YYYY-MM-DD",
      "status": "COMPLETED",
      "dataValues": [{"dataElement":"<deId>","value":"<optionCode>"}]
    }]
  }]
}
\`\`\`
- Set \`completedAt\` only if you need a specific date; otherwise DHIS2 auto-sets it on COMPLETED status.
- For COMPLETED enrollment: include ALL stage events that should be completed nested inside.

### One-active-enrollment rule
⚠️ DHIS2 allows ONLY ONE active enrollment per program per TEI (error E1015).
- To create a new ACTIVE enrollment: first COMPLETE the existing active one, then CREATE the new one.
- To complete an existing enrollment, UPDATE it with status=COMPLETED (see below).
- You CAN create a COMPLETED enrollment even when an active one exists.

### Updating enrollment status (e.g. ACTIVE→COMPLETED)
Required fields: enrollment, trackedEntity, program, orgUnit, enrolledAt, status.
\`\`\`
POST tracker?async=false&importStrategy=UPDATE
{
  "enrollments": [{
    "enrollment": "<enrollmentId>",
    "trackedEntity": "<teiId>",
    "program": "<programId>",
    "orgUnit": "<orgUnitId>",
    "enrolledAt": "<original enrolledAt date>",
    "status": "COMPLETED"
  }]
}
\`\`\`
⚠️ Missing enrolledAt → error "Property enrolledAt is null". Always include it from the existing enrollment data.

### Non-repeatable stages
⚠️ If a non-repeatable stage already has an event (even SCHEDULE status), you CANNOT create a second event (error E1039).
- UPDATE the existing event instead of creating a new one. Use importStrategy=UPDATE with the existing event ID.
- When creating a new COMPLETED enrollment with nested events, DHIS2 creates fresh events — no conflict with other enrollments.

### Updating events (data values or status)
Required fields: event, program, programStage, orgUnit.
\`\`\`
POST tracker?async=false&importStrategy=UPDATE
{
  "events": [{
    "event": "<eventId>",
    "program": "<programId>",
    "programStage": "<stageId>",
    "orgUnit": "<orgUnitId>",
    "occurredAt": "YYYY-MM-DD",
    "status": "COMPLETED",
    "dataValues": [{"dataElement":"<deId>","value":"<code>"}]
  }]
}
\`\`\`

### Mixed operations (CREATE_AND_UPDATE)
Use importStrategy=CREATE_AND_UPDATE to create new records AND update existing ones in one call.

### Multi-step task pattern (e.g. "create completed enrollment then new active profile")
1. Use enrollment IDs / dates / statuses already present in the Current Context section, or — only if the user explicitly authorizes it — query a specific enrollment via dhis2_query (path "tracker/enrollments/{id}"). Do NOT bulk-fetch the full TEI record; patient data lookup is disabled.
2. Create the COMPLETED enrollment with nested events in ONE call (importStrategy=CREATE)
3. If a new ACTIVE enrollment is needed and one already exists: complete the existing one first (importStrategy=UPDATE), then create the new one (importStrategy=CREATE)
`;
  }

  p += `
## DHIS2 Instance
- URL: ${dhis2.baseUrl}
- Version: ${dhis2.systemInfo?.version || '?'}
- API: ${dhis2.apiVersion}
`;

  // ── Contextual rules — only added when the relevant app/context is present ──
  if (hasVizCtx) {
    p += `
15. You are in Data Visualizer. Call get_visualization_details ONLY IF visualization data is not already available in this conversation. If a "Prefetched visualization context" system message is already present, use that data directly — do NOT call the tool again.
15.1. For value questions, use analytics_preview._resolved_table. If analytics_tables_missing, still give a FULL explanation using metadata (name, type, data items, periods, org units, layout). Mention the data limit briefly at the end only.
15.2. When explaining a visualization cover: (1) name & chart type, (2) data items with descriptions, (3) period scope, (4) org unit scope, (5) layout, (6) actual values if available, (7) chart settings.
`;
  }

  if (browseWeb) {
    p += `
16. Web browsing is ENABLED. Call browse_web for non-DHIS2 external/current information and cite URLs in your response.
17. NEVER use browse_web for DHIS2 instance data. Use get_visualization_details for charts, get_map_details for maps.
`;
  }

  if (inspectSnapshot?.enabled) {
    p += `
## Inspect Mode
Inspect mode is ENABLED. The user turned on page inspection before asking this question. You have captured browser console, runtime exception, and network error logs for the current active tab only.
- Treat the [Inspect Logs] block in the user message as first-class diagnostic evidence.
- First classify each important error: network/API status, JavaScript/runtime exception, DHIS2 program rule/program indicator expression error, permission/session issue, or harmless warning.
- For DHIS2 program rule errors, the rule ID in the logs is a HYPOTHESIS, not a verified target. First call manage_program_rules(action="get", rule_id=...) — if it returns 404, the ID is stale or from a prior context. STOP and DO NOT proceed with any "fix"; do not invent "stale cache" explanations (DHIS2 has no such cache). Instead, call manage_program_rules(action=list, program_id=Current Program ID) to see the actual current rules, or ask the user which rule.
- For DHIS2 program indicator expression errors, use manage_program_indicators(action="get" or action="audit") instead of guessing — and apply the same 404-means-stop rule.
- If a log contains "Failed to coerce value 'null' to Boolean", explain that the condition is evaluating a null/empty value as a Boolean. Recommend wrapping that comparison in d2:hasValue(...) or rewriting the OR group so every nullable value is guarded.
- If a log contains "Unknown function or constant", explain that the expression uses a function not supported by this DHIS2 expression engine/version or not valid in that expression type. Fetch the rule/indicator metadata before proposing an exact replacement.
- For 404/409/500 API logs, inspect the endpoint, UID, program, TEI, enrollment, stage, and current context. Use dhis2_query only for safe GET context checks unless the user explicitly asks you to fix metadata.
- Do not hide browser error details. Summarize the practical meaning and the next concrete fix steps.

### Diagnose BEFORE destroying metadata
- **Default to read-only.** Inspect mode gives you browser logs — those are symptoms, not proof of a specific metadata defect. Start by *explaining what the logs mean* and listing candidate causes, then ask the user before deleting or PATCH-ing anything.
- **Benign patterns — DO NOT "fix":**
  - \`staticContent/logo_banner\` 404 — DHIS2 returns 404 when no custom logo is uploaded; the app falls back to the default logo. This is not a bug. Never POST to staticContent (it's multipart-only and will return 500).
  - \`dataStore/capture/*\` or \`dataStore/settings/*\` 404 — those keys are app-owned and get created lazily on first use; do NOT write defaults yourself.
  - Vendor-prefix CSS rejections (\`-moz-\`, \`-ms-\`, \`-webkit-\`) in StyleSheet warnings — browser cosmetic, unrelated to app load.
  - Favicon / manifest / service-worker 404s — cosmetic, not a cause of app failure.
  - Mixed-content or extension-CSP warnings from the side panel or other extensions.
- **Never bulk-delete from Inspect conclusions.** "Orphan program rule variables" reported by audit are a *code-quality* finding, not a guaranteed cause of Capture load failure. Deleting them without confirmation removes authoring work and is rarely the right fix. If you believe deletion is necessary, list the exact IDs you propose to delete and ask "do you want me to delete these N items?" — wait for explicit "yes" before any DELETE / importStrategy=DELETE call.
- **Escalate to the user, not the DELETE endpoint.** If the Inspect logs show only harmless 404s / CSS warnings and no JS exception with a clear stack, say so: "The logs do not show a metadata defect. The app-load failure is likely <hypothesis>. Want me to gather more details (network waterfall, DHIS2 server logs, permissions) before making changes?"
- Prefer \`manage_metadata(action=delete, ...)\` or \`manage_program_rules(action=delete, rule_id=...)\` for single-object deletes (they check references first) — not raw \`dhis2_query\` with \`importStrategy=DELETE\`. Bulk delete via dhis2_query now requires \`confirm_bulk_delete:true\` AND is still a last resort.

### Verify before modify (mandatory)
- Before ANY destructive call (update/delete/bulk_fix on rules, indicators, metadata), the chatbot's tool layer auto-verifies the target ID via GET. **A 404 from that lookup is a STOP — do not proceed, do not invent a "stale cached rule" explanation, do not retry with a different action that performs the same write.**
- Inspect logs may carry rule IDs from previous app loads or unrelated programs. The DHIS2 rule engine evaluates against the live database; **there is no "stale rule cache"** that returns ghost objects. If a rule ID is in the logs but the live API says 404, the ID is wrong (or already deleted) — full stop.
- After 2 consecutive 404s on destructive lookups in this turn, ALL further write attempts are hard-blocked. If you hit this, summarize the 404 history to the user and ask which ACTUAL current object should be acted on.

### NEVER recommend cache-clearing as a DHIS2 fix
- ❌ Do NOT recommend "Hard refresh", "Ctrl+Shift+R", "Cmd+Shift+R", "clear browser cache", "incognito mode", "App Management → resource cache", or "clear DHIS2 cache".
- DHIS2 server-side errors (404/409/500 from /api/...) have nothing to do with browser cache. Recommending cache-clearing for these is hallucination and wastes the user's time. The only legitimate use of "hard refresh" is when the *Capture/Tracker app bundle itself* fails to load due to a stale service-worker — and even then, ask the user before recommending it.
`;
  }

  // ── Save / Load failure diagnosis (enrollment, event, TEI, dataset) ──
  // Triggered when the user reports a save/load failure or when inspect logs
  // show a 409 from the tracker API. This is the canonical KB the model must
  // consult BEFORE forming any hypothesis. It blocks the failure mode where
  // "error saving enrollment" was misdiagnosed as a program-rule issue.
  const saveFailureMode = SAVE_FAILURE_RE.test(text)
    || (inspectSnapshot?.enabled && /\b409\b|enroll/i.test(JSON.stringify(inspectSnapshot.insights || {})));
  if (saveFailureMode) {
    p += `
## Save / Load failure diagnosis — investigate AUTOMATICALLY

You MUST diagnose by yourself. The user has reported a save error; they should NOT have to give you the error code, copy DevTools output, or pick from a menu of E-codes. The chatbot has the program ID in page context and has tools — USE THEM.

### What to do immediately
A diagnostic context bundle is pre-fetched and attached to this conversation as a system message labelled \`[Save-error diagnostic context — pre-fetched]\`. It contains:
- The program's save-relevant flags (\`selectEnrollmentDatesInFuture\`, \`selectIncidentDatesInFuture\`, \`onlyEnrollOnce\`, mandatory attributes, assigned OUs, user access)
- The current user's org units and roles
- Any existing enrollments for the TEI in context
- A \`findings\` array with the most likely E-codes ranked by risk

**Open that bundle. Read \`findings[]\`. The lead finding is the most likely cause.** Tell the user that finding directly as a statement, not as a question or a list.

If \`findings\` is non-empty:
- Pick the lead (highest-risk) finding. State the cause in one sentence: "This program has selectEnrollmentDatesInFuture=false, so future enrollment dates are not allowed (DHIS2 error E1020)."
- If the lead is E1020/E1021, ask ONE confirmation question: "Did you enter a date later than today?" — that's all.
- If the lead is E1015 (active enrollment exists), name it: "This entity is already enrolled in this program (enrollment X started on Y). E1015 blocks duplicate active enrollments."
- If the lead is E1016 (onlyEnrollOnce + prior enrollment), name it.
- If the lead is E1018, list the mandatory attributes BY NAME from the bundle.
- If the lead is E1041 or E1000, name the OU mismatch.
- If the lead is E1091, say the user lacks program write access.

If \`findings\` is empty (rare), THEN ask the user one specific question — about what they entered into the form. Do NOT ask for the error code or DevTools output. Do NOT recite the E-code list.

### What to NEVER do for save errors
- ❌ List every E-code as a "common cause" menu and ask the user to pick.
- ❌ Ask the user to open DevTools, copy the response body, or share the error code. The chatbot can fetch the relevant config itself.
- ❌ Tell the user to "Hard refresh", "clear browser cache", "Ctrl+Shift+R", "incognito mode", or "App Management → resource cache". Server validation errors are unaffected by browser cache.
- ❌ Invent "stale cached rules" / "ghost rule IDs". DHIS2 evaluates rules against the live database.
- ❌ Edit or "fix" program rules. Rules CAN cause E1300 — but only if the response body says so. Without that confirmation, modifying rules is wrong.
- ❌ Auto-fixing anything without explicit user authorization. The tool layer enforces this — destructive actions return refusal until the user authorizes on a follow-up turn.

### Background facts (for your reasoning, not for output)
- Save error codes covering nearly all enrollment failures: E1014 (program without registration), E1015 (active enrollment exists), E1016 (onlyEnrollOnce), E1018 (mandatory attr missing), E1020/E1021 (future date blocked), E1022 (TE type mismatch), E1023 (incident-date null when displayIncidentDate=true), E1025 (enrolledAt null), E1041 (OU not assigned), E1052/E1080/E1081/E1113 (UID/state issues), E1000 (no OU access), E1091 (no program access), E1300 (program rule blocked save via SHOWERROR/ERRORONCOMPLETION/SETMANDATORYFIELD/ASSIGN-overwrite).
- Client-side "Failed to coerce value 'null'" console errors are RENDERING errors from the browser-side rule engine — they do NOT prove the server returned E1300. Treat them as low-priority signal.

### Authorization rule (tool-enforced)
Every user message is classified into a write-authorization scope. A problem report is read_only — the default. Every destructive action will be refused until the user explicitly authorizes a fix ("yes", "fix it", "go ahead", "update X", "delete it") on a follow-up turn. Even when the user authorizes, modifying program rules is only correct AFTER you have confirmation (from a 409 body or import summary) that the cause is E1300 — not before.
`;
  }

  // ── Universal "verify before call" rule ──
  // Backed by the tool-layer pre-flight that refuses calls referencing
  // unverified UIDs and that hard-stops after 3 HTTP errors in a turn.
  p += `

## Verify-before-call (universal, applies to every tool)
EVERY tool call MUST derive from data you have already verified. Verified sources are:
1. The user's message text (UIDs the user pasted).
2. The page context (current program/TEI/visualization/map IDs from the URL).
3. Inspect-mode snapshot insights and logs (when present).
4. Prior tool results in THIS conversation turn.
5. The conversation history — objects you created or read in PRIOR turns stay verified; reference them directly by the UID from the earlier result instead of re-listing.

When you need to operate on a resource you have not yet seen:
1. **First call must be a discovery call.** Use \`search_metadata\`, \`manage_program_rules(action=list)\`, \`manage_program_indicators(action=list)\`, \`get_program_info\`, or a list endpoint via \`dhis2_query\` (e.g. \`programs?fields=id,displayName\`).
2. **From that response, pick a UID that ACTUALLY appeared in the result.** Do not guess, do not pattern-match a similar-looking UID, do not carry forward a UID that returned 404.
3. **Use that verified UID on the next call.**

The tool layer enforces this:
- Calls with UID arguments (rule_id, indicator_id, object_id, path, etc.) referencing a UID that has not appeared anywhere in verified sources are refused with \`unknown_uid_in_args\`.
- After 2 consecutive destructive 404s, all further destructive calls are blocked.
- After 3 HTTP 4xx/5xx errors total, all further tool calls are blocked. If you hit this, summarize the error history to the user and ask which CURRENT object should be acted on.

When a call returns 404 or 409:
- **404**: the path / UID / resource does not exist. STOP. Do not retry the same path. Do not try a similar verb. Do not invent "stale cache" explanations. Either ask the user, or call a discovery endpoint.
- **409**: the request body or constraints are wrong. Read the error code (E1xxx for tracker, importSummary for metadata). STOP. Do not retry without first correcting the request based on the error.
`;

  // ── Multi-step orchestration playbook — only for compound goals ──
  // Teaches decomposition, dependency ordering, and ID-chaining across tools so
  // the model finishes a goal whose pieces don't exist yet (the canonical
  // "build a dashboard that needs new indicators, then share it" chain) entirely
  // on its own. Gated on wantsMultiStepGoal so it never bloats single-step turns.
  if (wantsMultiStepGoal) {
    p += `
## Multi-step goals — decompose, order by dependency, chain IDs
This request needs SEVERAL DEPENDENT steps to finish (e.g. a dashboard whose indicators/visualizations don't exist yet, or "set up a program AND its indicators AND a dashboard AND sharing"). Do NOT stop after the first tool and do NOT hand the remaining steps back to the user. Plan the WHOLE chain, then execute every step yourself, in dependency order, feeding each tool's returned UID into the next tool's inputs.

### Procedure
1. UNDERSTAND the end state: list every object that must EXIST when you are done.
2. Walk the dependencies BACKWARDS: a dashboard needs visualizations; a visualization needs data items (indicators / data elements / program indicators); an aggregate indicator needs the data elements in its numerator/denominator. For each piece, check whether it already exists (search_metadata or a list action) or must be CREATED first.
3. ORDER the steps so every input exists before it is referenced — create the missing LEAF metadata FIRST, then the objects that reference it, and do SHARING/access LAST.
4. EXECUTE each step and READ ITS RESULT. Capture the new UID the tool returns:
   - manage_indicators(action="create") → \`indicator_id\` (AGGREGATE indicator)
   - manage_program_indicators(action="create") → \`program_indicator_id\` (TRACKER/event indicator)
   - manage_dashboards(action="create_visualization") → \`visualization_id\`
   - manage_dashboards(action="create_dashboard") → \`dashboard_id\` (+ \`new_visualizations[]\`)
   - manage_option_sets(action="create") → \`option_set_id\`
   - manage_legend_sets(action="create") → \`legend_set_id\` (a reusable colour band scale)
   - create_metadata(action="create_data_elements") → each new DE's id in \`summary.dataElements[].id\`
   - create_metadata / manage_datasets / manage_org_units / manage_legend_sets / manage_validation_rules → the \`id\` (or \`*_id\`) in their result.
5. CHAIN that UID into the next step — never re-type, summarise, or invent it. A new indicator's \`indicator_id\` — or a new program indicator's \`program_indicator_id\` — goes straight into the dashboard's \`new_visualization.data_items\` (data_items accepts aggregate-indicator, dataElement AND programIndicator UIDs interchangeably; the tool auto-resolves each UID's type, so a tracker program indicator plots on a dashboard exactly like an aggregate one). A saved visualization's id goes into a dashboard item's \`visualization_id\`. A new option set's \`option_set_id\` goes into a data element via create_metadata(action="create_data_elements", data_elements:[{ name, value_type, option_set_id:<option_set_id> }]) — pass \`option_set_id\` to REFERENCE the existing set (the DE valueType auto-aligns); NEVER re-inline the same options with \`option_set:{...}\` (that creates a DUPLICATE set). A new DE id then goes into manage_datasets(action="add_data_elements", dataset_id, data_element_ids:[<id>]). A new legend set's \`legend_set_id\` goes into an aggregate indicator via manage_indicators(action="create", indicator:{ …, legend_set_id:<legend_set_id> }) — so the indicator renders colour-coded (traffic-light) on the dashboard; NEVER attach a legend with a raw dhis2_query PATCH and NEVER via manage_metadata (it has no legend action). (This is exactly the verified provenance the Verify-before-call rule demands.)
6. SHARE last: manage_metadata(action="update_sharing", object_type="dashboards"|"visualizations"|"indicators"|…, object_id=<the id you just created>, …). NEVER set sharing with a raw dhis2_query PUT — it fails.

### Worked chain — "build a malaria dashboard that needs new indicators, then make it public"
1. search_metadata(object_type="dataElements", query=…) → the data-element UIDs the indicator formulas need (e.g. malaria deaths, malaria cases).
2. manage_indicators(action="create", indicator:{ name, numerator:"#{deathsUID}", denominator:"#{casesUID}", indicator_type:"Per cent" }) for EACH missing indicator → keep each returned \`indicator_id\`.
3. manage_dashboards(action="create_dashboard", dashboard:{ name:"Malaria Surveillance" }, items:[ { new_visualization:{ name:"CFR by month", vis_type:"COLUMN", data_items:[<indicator_id #1>], periods:["LAST_12_MONTHS"], org_units:["<ou>"] } }, { new_visualization:{ name:"ACT coverage", vis_type:"SINGLE_VALUE", data_items:[<indicator_id #2>], periods:["THIS_YEAR"], org_units:["<ou>"] } } ]) — the inline visualizations and the dashboard import atomically; keep the returned \`dashboard_id\`.
4. manage_metadata(action="update_sharing", object_type="dashboards", object_id=<dashboard_id>, public_access="r-------") so everyone can view it.

### Worked chain — "build a colour-coded ANC coverage indicator with a traffic-light legend and put it on a public dashboard"
1. search_metadata(object_type="dataElements", query=…) → the numerator/denominator DE UIDs (e.g. ANC 1st visit, expected pregnancies).
2. manage_legend_sets(action="create", legend_set:{ name:"Coverage 0–100 (RAG)" }, auto_bands:{ start:0, end:100, count:3 }) → keep the returned \`legend_set_id\` (red→amber→green low→high).
3. manage_indicators(action="create", indicator:{ name:"ANC 1st visit coverage", numerator:"#{anc1Uid}", denominator:"#{expectedUid}", indicator_type:"Per cent", legend_set_id:<legend_set_id> }) → the indicator is created AND the legend attached in ONE call; keep \`indicator_id\`.
4. manage_dashboards(action="create_dashboard", dashboard:{ name:"ANC Coverage" }, items:[ { new_visualization:{ name:"ANC coverage by month", vis_type:"COLUMN", data_items:[<indicator_id>], periods:["LAST_12_MONTHS"], org_units:["<ou>"] } } ]) → keep \`dashboard_id\`.
5. manage_metadata(action="update_sharing", object_type="dashboards", object_id=<dashboard_id>, public_access="r-------").

### Worked chain — "build the analytical package (program indicators + charts + maps + dashboard) for a TRACKER program"
This is the shape of a big coverage/monitoring build. Do it in a HANDFUL of batched calls, never dozens of single ones.
1. get_program_info(program_id=<the tracker>) → the REAL stage UIDs + data element UIDs. Every #{stage.de} you write must come from here.
2. PLAN the indicator set. Each "% / rate / coverage" metric = **ONE** program indicator: analytics_type ENROLLMENT, filter = the denominator population, expression = \`d2:condition("<numerator condition>", 100, 0)\`, aggregation_type AVERAGE, decimals 1 (see the manage_program_indicators manual). Add a COUNT/SUM program indicator ONLY for a headline number (e.g. "active pregnancies") or when a table/breakdown explicitly needs the raw numerator, denominator, or category counts as their own columns. Do NOT split every percentage into numerator + denominator + percentage objects.
3. manage_program_indicators(action="create", program_id, indicators:[ …all of them… ]) — ONE batched call. Keep the returned \`program_indicator_ids\`. (Re-batch only the entries returned under failed[], if any.)
4. manage_legend_sets(action="create", …) for the map/RAG colour bands → keep each \`legend_set_id\`.
5. manage_maps(action="create", data_item:<a program_indicator_id>, org_unit_level:2, legend_set_id:<…>) for EACH thematic map → keep each \`map_id\`. (Maps are created one per call; there is no inline-map on a dashboard.)
6. manage_dashboards(action="create_dashboard", dashboard:{ name }, items:[ …]) — build the WHOLE dashboard in ONE call: each chart/pivot/single-value tile as an inline \`new_visualization\` (data_items = the program_indicator_ids), each map as \`{ type:"MAP", map_id }\`, section headers as \`{ type:"TEXT", text:"## ANC coverage" }\`. Keep \`dashboard_id\`.
7. manage_metadata(action="update_sharing", object_type="dashboards", object_id=<dashboard_id>, …) LAST.

### Worked chain — "create an option set for RDT results, a data element that uses it, and add it to the monthly malaria dataset"
1. manage_option_sets(action="create", option_set:{ name:"Malaria RDT Result", options:[{code:"POS",name:"Positive"},{code:"NEG",name:"Negative"},{code:"INV",name:"Invalid"}] }) → keep the returned \`option_set_id\`.
2. create_metadata(action="create_data_elements", data_elements:[{ name:"Malaria RDT outcome", value_type:"TEXT", domain_type:"AGGREGATE", option_set_id:<option_set_id> }]) → the DE REFERENCES the set just created (do NOT re-inline the options); keep the new DE id from \`summary.dataElements[0].id\`.
3. manage_datasets(action="add_data_elements", dataset_id:<the dataset UID>, data_element_ids:[<DE id>]) — resolve the dataset UID first via search_metadata(object_type="dataSets") if you don't have it in context.
Run all steps without pausing. Only ask the user when a step is genuinely ambiguous (e.g. which data element represents "malaria cases").
`;
  }

  if (hasMapCtx) {
    p += `
18. You are in Maps. Call get_map_details ONLY IF map data is not already available in this conversation. If a "Prefetched map context" system message is already present, use that data directly — do NOT call the tool again.
18.1. When explaining a map cover: (1) map name & basemap, (2) each layer type and what data it shows, (3) geographic scope, (4) time period, (5) styling, (6) program/stage for event layers, (7) analytics preview if available.
18.2. For value questions use layer_analytics_previews. If unavailable, explain map structure and note that the admin needs to run the analytics export job.
`;
  }

  if (hasTeiCtx) {
    p += `
19. A TEI ID appears in the page URL, but patient/TEI data lookup is DISABLED in this build. For any question explicitly about THIS person/patient ("this person", "this patient", "summary", "overview", "last visit", "show events", "when enrolled", their attributes, age, gender, name, etc.):
19.1. Reply that patient-level data retrieval has been disabled by the extension owner for privacy reasons.
19.2. Do NOT attempt to fetch tracker/trackedEntities/${ctx.teiId || '{id}'} via dhis2_query, and do NOT fetch any per-person attributes / enrollments / events endpoint.
19.3. Offer the user program-level alternatives instead: aggregate counts (count_records), trends/breakdowns (get_event_analytics), program structure (get_program_info), or rules/indicators audits.
`;
  }

  if (ctx.programId || ctx.orgUnitId || ctx.visualizationId || ctx.mapId || ctx.datasetId) {
    p += '\n## Current Context (USE THESE — never ask the user)\n';
    if (ctx.appType) p += `- App: ${ctx.appType}\n`;
    if (ctx.programId) p += `- **Program ID: ${ctx.programId}** ← always use this (this is a PROGRAM, not a stage)\n`;
    if (ctx.datasetId) p += `- **Dataset ID: ${ctx.datasetId}** ← user is viewing/editing THIS dataset (aggregate "program"). Never ask which dataset; use this UID.\n`;
    if (ctx.periodId) p += `- **Period: ${ctx.periodId}** ← current data-entry period\n`;
    if (ctx.orgUnitId) p += `- **Org Unit ID: ${ctx.orgUnitId}** ← always use this\n`;
    if (dhis2.lastFacilityOu?.id) {
      const facilityLabel = dhis2.lastFacilityOu.id === ctx.orgUnitId
        ? `${dhis2.lastFacilityOu.name} (${dhis2.lastFacilityOu.id})`
        : `${dhis2.lastFacilityOu.name} (${dhis2.lastFacilityOu.id}) [lowest OU in current scope]`;
      p += `- **Default Count Scope: ${facilityLabel}** ← for enrollment/event/TEI counts, use this lowest OU unless the user explicitly asks for descendants/all org units\n`;
    }
    if (ctx.visualizationId) p += `- **Visualization ID: ${ctx.visualizationId}** ← use for Data Visualizer questions\n`;
    if (ctx.mapId) p += `- **Map ID: ${ctx.mapId}** ← use for Maps questions\n`;
    if (ctx.stageId) {
      // Resolve stage name from program metadata for prominent display
      const stageName = prog?.programStages?.find(s => s.id === ctx.stageId)?.displayName || null;
      if (stageName) {
        p += `- **Current Stage: ${stageName} (${ctx.stageId})** ← user is viewing THIS stage. For "this stage" questions, use this stage ID with get_program_info(stage_details, target_id="${ctx.stageId}")\n`;
      } else {
        p += `- **Current Stage ID: ${ctx.stageId}** ← user is viewing this stage\n`;
      }
    }
    if (!ctx.stageId && prog?.programStages?.length > 1) {
      p += `- ⚠️ No specific stage detected in context. If user asks about "this stage", you MUST ask which stage they mean — do NOT guess. Available stages: ${prog.programStages.map(s => `${s.displayName} (${s.id})`).join(', ')}\n`;
    }
    if (ctx.teiId) p += `- TEI ID: ${ctx.teiId}\n`;
    if (ctx.enrollmentId) p += `- Enrollment ID: ${ctx.enrollmentId}\n`;
    if (ctx.eventId) p += `- Event ID: ${ctx.eventId}\n`;
  }

  if (ou) {
    p += `\n## Org Unit: ${ou.displayName} (${ou.id}), Level ${ou.level}\n`;
    if (ou.ancestors?.length) {
      p += `  Path: ${ou.ancestors.map(a => a.displayName).join(' → ')} → ${ou.displayName}\n`;
    }
    if (ou.children?.length) {
      p += `  Children (${ou.children.length}): ${ou.children.slice(0, 10).map(c => `${c.displayName}(${c.id})`).join(', ')}${ou.children.length > 10 ? '...' : ''}\n`;
    }
  }

  if (dhis2.visualizationContext?.id) {
    p += `\n## Visualization Context\n`;
    p += `- Name: ${dhis2.visualizationContext.name || dhis2.visualizationContext.id}\n`;
    p += `- ID: ${dhis2.visualizationContext.id}\n`;
    if (dhis2.visualizationContext.type) p += `- Type: ${dhis2.visualizationContext.type}\n`;
  }

  if (dhis2.mapContext?.id) {
    p += `\n## Map Context\n`;
    p += `- Name: ${dhis2.mapContext.name || dhis2.mapContext.id}\n`;
    p += `- ID: ${dhis2.mapContext.id}\n`;
    p += `- Layers: ${dhis2.mapContext.layerCount || 0}\n`;
    if (dhis2.mapContext.layers?.length) {
      p += `- Layer types: ${dhis2.mapContext.layers.map(l => `${l.layer} (${l.name})`).join(', ')}\n`;
    }
  }

  if (dhis2.datasetContext?.id) {
    const dc = dhis2.datasetContext;
    p += `\n## Dataset (Aggregate "Program") Context\n`;
    p += `- Name: ${dc.name}\n`;
    p += `- ID: ${dc.id}\n`;
    if (dc.shortName) p += `- Short name: ${dc.shortName}\n`;
    if (dc.periodType) p += `- Period type: ${dc.periodType}\n`;
    if (dc.formType) p += `- Form type: ${dc.formType}\n`;
    if (dc.categoryCombo) p += `- Category combo: ${dc.categoryCombo}${dc.isDefaultCombo ? ' (default — no attribute disaggregation)' : ''}\n`;
    p += `- Data elements: ${dc.dataElementsCount}, Sections: ${dc.sectionsCount}, Org units: ${dc.orgUnitsCount}, Indicators: ${dc.indicatorsCount}\n`;
    if (dc.openFuturePeriods != null) p += `- openFuturePeriods: ${dc.openFuturePeriods}, expiryDays: ${dc.expiryDays}, timelyDays: ${dc.timelyDays}\n`;
    // Active selection bound to this dataset (OU + period + attribute option combo + section)
    if (dhis2.ouContext?.id) {
      p += `- Selected org unit: ${dhis2.ouContext.displayName} (${dhis2.ouContext.id})${dhis2.ouContext.level ? ` — level ${dhis2.ouContext.level}` : ''}\n`;
    } else if (ctx?.orgUnitId) {
      p += `- Selected org unit: ${ctx.orgUnitId} (resolution pending)\n`;
    }
    if (ctx?.periodId) p += `- Selected period: ${ctx.periodId}\n`;
    if (ctx?.attributeOptionComboSelection) {
      const pairs = Object.entries(ctx.attributeOptionComboSelection)
        .map(([cat, opt]) => `${cat}=${opt}`).join(', ');
      p += `- Attribute option combo selection: { ${pairs} }\n`;
    }
    if (ctx?.sectionFilter) p += `- Active section: ${ctx.sectionFilter}\n`;
    if (dc.canWriteData === false) {
      p += `- ⚠️ Current user does NOT have data write access on this dataset. They can read it but not enter data. To fix: manage_datasets(action="update_sharing", dataset_id="${dc.id}", public_access="rwrw----").\n`;
    }
    if (dc.orgUnitsCount === 0) {
      p += `- ⚠️ This dataset has NO assigned org units — it will not appear in any user's Data Entry app. Use manage_datasets(action="assign_org_units", dataset_id="${dc.id}", org_unit_ids=[...]) before users can enter data.\n`;
    }
  }

  if (prog) {
    p += `\n## Program: ${prog.displayName} (${prog.id})\n`;
    p += `- Type: ${prog.programType} (${prog.programType === 'WITH_REGISTRATION' ? 'Tracker' : 'Event'})\n`;
    if (prog.trackedEntityType) p += `- Tracked Entity: ${prog.trackedEntityType.displayName}\n`;
    if (dhis2.programRulesCount != null) p += `- Program Rules: ${dhis2.programRulesCount}\n`;
    if (prog.programIndicators?.length) p += `- Program Indicators: ${prog.programIndicators.length}\n`;

    // Tracked Entity Attributes
    if (prog.programTrackedEntityAttributes?.length) {
      p += `\n### Attributes (${prog.programTrackedEntityAttributes.length})\n`;
      p += `| Name | ID | Type | Options |\n|---|---|---|---|\n`;
      for (const ptea of prog.programTrackedEntityAttributes) {
        const a = ptea.trackedEntityAttribute;
        const name = a.displayFormName || a.displayName;
        let opts = '-';
        if (a.optionSet) {
          const optsList = a.optionSet.options.slice(0, 4).map(o => `${o.displayName}(${o.code})`);
          const more = a.optionSet.options.length > 4 ? `+${a.optionSet.options.length - 4}more` : '';
          opts = optsList.join(', ') + (more ? ', ' + more : '');
        }
        const flags = [ptea.mandatory ? 'M' : '', ptea.searchable ? 'S' : '', a.unique ? 'U' : ''].filter(Boolean).join('');
        p += `| ${name}${flags ? ` [${flags}]` : ''} | ${a.id} | ${a.valueType} | ${opts} |\n`;
      }
    }

    // Program Stages
    if (prog.programStages?.length) {
      const stages = [...prog.programStages].sort((a, b) => (a.sortOrder||0) - (b.sortOrder||0));
      p += `\n### Stages (${stages.length})\n`;
      for (const stage of stages) {
        const deCount = stage.programStageDataElements?.length || 0;
        p += `\n**${stage.displayName}** (${stage.id}) — ${deCount} data elements\n`;
        if (stage.programStageDataElements?.length) {
          // Show up to 20 data elements per stage to keep prompt lean
          const limit = 20;
          for (const psde of stage.programStageDataElements.slice(0, limit)) {
            const de = psde.dataElement;
            const name = de.displayFormName || de.displayName;
            let line = `- ${name} (${de.id}) [${de.valueType}]`;
            if (psde.compulsory) line += ' REQ';
            if (de.optionSet) {
              const optsSample = de.optionSet.options.slice(0, 3).map(o => `${o.displayName}(${o.code})`);
              const moreOpts = de.optionSet.options.length > 3 ? `,+${de.optionSet.options.length - 3}more` : '';
              line += ` opts:${optsSample.join(',')}${moreOpts}`;
            }
            p += line + '\n';
          }
          if (deCount > limit) p += `  ...+${deCount - limit} more DEs\n`;
        }
      }
    }

    // Program Indicators (first 5 as orientation — use manage_program_indicators for full list/audit)
    if (prog.programIndicators?.length) {
      p += `\n### Program Indicators (${Math.min(5, prog.programIndicators.length)} of ${prog.programIndicators.length} shown — use manage_program_indicators for full list)\n`;
      for (const pi of prog.programIndicators.slice(0, 5)) {
        p += `- ${pi.displayName} (${pi.id})\n`;
      }
    }
  }

  // ── Datasets / Aggregate-data KB block ──
  // Only included when the user is in a data-entry / dataset-report / agg-data
  // page, OR when their text mentions datasets / aggregate data / period type /
  // category combos. Keeps the prompt lean for unrelated turns.
  if (hasDatasetCtx || inAggDataEntryCtx || wantsDatasetPrompt) {
    p += `
## DHIS2 Datasets (Aggregate "Programs")
A DHIS2 **dataSet** is the aggregate-data equivalent of a tracker program. Users saying "aggregate program" / "monthly form" / "reporting form" mean a dataSet. Use **manage_datasets** for ALL dataset operations (create/update/delete, DE membership, OU assignment, sharing, sections); NEVER write raw dataset bodies via dhis2_query. For data entry to work a dataset needs data-level sharing ("rwrw----") AND assigned org units — the tool defaults these correctly.
- NEW disaggregation (category combos) → create_metadata(action="create_category_combo"); aggregate DEs (optionally bound to a combo) → create_metadata(action="create_data_elements", domain_type="AGGREGATE"). NEVER assemble raw category-combo /metadata POSTs.
- "What dataset am I in?" → answer from the Dataset Context block above; do NOT call any tool.
`;
  }

  // ── Validation Rules KB — aggregate data-quality checks (manage_validation_rules) ──
  if (wantsValidationRulePrompt) {
    p += `
## DHIS2 Validation Rules (manage_validation_rules)
A **validationRule** is an aggregate data-quality check comparing a leftSide vs rightSide expression with an operator, evaluated per period. Use **manage_validation_rules** (list/get/create/update/delete) for ALL validation-rule work — never hand-write /metadata bodies via dhis2_query. Both expressions are server-validated before saving; resolve data-element UIDs via search_metadata / manage_datasets(action=get), never invent them.
`;
  }

  // ── Org-Unit hierarchy KB — organisationUnits (manage_org_units) ──
  if (wantsOrgUnitPrompt) {
    p += `
## DHIS2 Organisation Units (manage_org_units)
The org-unit hierarchy is the tree of facilities/chiefdoms/districts every program, dataset and enrollment is attached to. Use **manage_org_units** (list/get/create/update/delete) for ALL org-unit STRUCTURE work — create under a parent, rename/close, MOVE/re-parent, delete a leaf — never hand-write /metadata bodies via dhis2_query. \`level\`/\`path\` are DERIVED from the parent (never set them); resolve parent UIDs via list/search_metadata, never invent them.
`;
  }

  // ── Aggregate Indicators KB — numerator/denominator formulas (manage_indicators) ──
  if (wantsIndicatorPrompt) {
    p += `
## DHIS2 Aggregate Indicators (manage_indicators)
An aggregate **indicator** is (numerator / denominator) × the indicatorType factor — what dashboards, pivots and maps usually display. Use **manage_indicators** (list/get/create/update/delete) for ALL aggregate-indicator work — never hand-write /metadata bodies via dhis2_query. IMPORTANT: **tracker/event program indicators are a DIFFERENT object** — use manage_program_indicators for those. Expressions are server-validated before save; resolve UIDs via search_metadata, never invent them.
`;
  }

  // ── Option Sets KB — reusable code/label pick-lists (manage_option_sets) ──
  if (wantsOptionSetPrompt) {
    p += `
## DHIS2 Option Sets (manage_option_sets)
An **option set** is a reusable, ordered pick-list of \`{ code, name }\` pairs constraining a DE or TEA to fixed choices. Use **manage_option_sets** (list/get/create/update/add_options/remove_options/reorder_options/delete) for ALL standalone option-set work — never hand-write option bodies via dhis2_query. For an option set inline on a NEW data element use create_metadata instead; to CONVERT a set to MULTI_TEXT (multi-select, cascaded) use manage_metadata(action=convert_value_type).
`;
  }

  // ── Legend Sets KB — reusable colour-coded value bands (manage_legend_sets) ──
  if (wantsLegendSetPrompt) {
    p += `
## DHIS2 Legend Sets (manage_legend_sets)
A **legend set** is a reusable, ordered list of colour bands rendering numeric values as a traffic-light / heat-map scale. Use **manage_legend_sets** (list/get/create/add_legends/remove_legends/update/delete; create supports auto_bands for a red→amber→green ramp) — never hand-write legendSets bodies via dhis2_query. A legend set only DEFINES the scale; attach it to an aggregate indicator via manage_indicators(legend_set_id) — NEVER via raw dhis2_query PATCH or manage_metadata (no legend action).
`;
  }

  // ── Dashboards & Visualizations KB — analytics dashboard builder (manage_dashboards) ──
  if (wantsDashboardPrompt) {
    p += `
## DHIS2 Dashboards & Visualizations (manage_dashboards)
A **visualization** is a saved chart/pivot/single-value tile; a **dashboard** arranges several of them (plus maps/text tiles). Use **manage_dashboards** for ALL dashboard/visualization CREATION — NEVER hand-assemble \`visualizations\`/\`dashboards\` bodies via dhis2_query (a raw POST imports an EMPTY, un-renderable chart; a raw dashboard PUT permanently WIPES its existing tiles). To add to an EXISTING dashboard, action="add_items" is the ONLY safe path. **render_chart** = quick inline preview in chat; **manage_dashboards** = SAVE a reusable visualization/dashboard in DHIS2 — different jobs. Sharing/deletion of standalone visualizations/maps → manage_metadata.
`;
  }

  // ── Custom Forms KB — dataset & program-stage HTML data-entry forms ──
  if (wantsCustomFormPrompt || inTrackerCtx || hasDatasetCtx || inAggDataEntryCtx) {
    p += `
## DHIS2 Custom (HTML) Forms — use the **manage_custom_forms** tool
A CUSTOM form is hand-laid-out HTML for data entry, for BOTH dataSets (Aggregate Data Entry app) and tracker/event program STAGES (Capture app). "Create/design a custom form", "html form", "custom layout" → **manage_custom_forms** — never assemble raw POST/PUT bodies via dhis2_query. For a dataset pass \`dataset_id\`; for a tracker/event stage pass \`program_stage_id\` (the STAGE id, NOT the program id — the form lives on the STAGE). action=preview_html shows the auto-generated form without saving; set_dataset_form / set_stage_form save it (omit html_code to auto-generate).
`;
  }

  // ── Custom Translations KB — translate / re-label app UI strings (DHIS2 2.43+) ──
  if (wantsTranslationPrompt) {
    p += `
## DHIS2 Custom Translations — use the **manage_custom_translations** tool
EXPERIMENTAL DHIS2 2.43+ feature: translate or re-label an app's UI strings via the "custom-translations" dataStore — no source-code changes. "Translate this app", "rename a button/label", "reword the UI" → **manage_custom_translations** (list/get/set/remove) — NEVER hand-write those dataStore keys via dhis2_query (the controller registry must stay in sync; the tool does that). Source strings must match the on-screen text EXACTLY.
`;
  }

  // ── Growth Chart plugin KB — WHO Capture Growth Chart setup ──
  if (wantsGrowthChartPrompt) {
    p += `
## WHO Capture Growth Chart plugin — use the **manage_growth_chart_plugin** tool
Sets up the "Capture Growth Chart" plugin so WHO growth charts render on a tracker program's enrollment dashboard in Capture. Use **manage_growth_chart_plugin** (status → install → configure(program_id) → relay the returned dashboard_attach steps; scaffold_program creates a ready-made growth-monitoring program). NEVER hand-assemble its dataStore via dhis2_query.
`;
  }

  // ── Meta-Architect Protocol (decide-time core) — only when creating/modifying metadata ──
  // The deep how-to (payload slots, error recovery, value-type mapping, rule
  // syntax, PI grammar) lives in the tool manuals delivered on first use.
  if (isCreating || wantsProgramRulesPrompt || wantsProgramIndicatorsPrompt) {
    p += `
## DHIS2 Meta-Architect Protocol

### ⚠️ CRITICAL: Creating Programs — ONE-CALL pattern
When asked to create a program, you MUST use **create_metadata(action=create_program)** with ALL components (program_attributes, org_unit_ids, sharing, stages + data elements with inline option sets, program_rules, program_indicators) in a SINGLE call. The tool handles the full dependency chain atomically, auto-resolves name→ID references, and reuses existing option sets/DEs/TEAs by name.
**Mandatory workflow:** (1) outline your plan in your text response; (2) ONE create_metadata(action=create_program) call with everything; (3) verify with architect_metadata(action=verify).
⚠️ **NEVER** create option sets, DEs, or TEAs with separate tool calls when building a program — the ONE-CALL pattern handles everything.
⛔ **NEVER paginate org units** to gather "all OUs" — for "all OUs / all levels / all facilities" pass \`assign_all_org_units: true\` (one server-side call).
⚠️ \`org_unit_ids\` (where the program is usable in Capture) and \`sharing\` (who has access) are SEPARATE concepts — set both.
⚠️ **NEVER** use dhis2_query PUT/PATCH on programRules or programIndicators (409/415) — use manage_program_rules / manage_program_indicators.
⚠️ **NEVER** call tools unrelated to metadata creation (e.g., get_visualization_details) when the user asks to create a program.

### Routing for EXISTING programs
- Add DEs to an existing stage → create_metadata(action=add_data_elements_to_stage); add a stage → create_metadata(action=add_stage); more rules → create_metadata(action=add_program_rules).
- Add TEAs to an existing program → manage_metadata(action=add_program_attributes) — NEVER PATCH programs/{id} or POST programTrackedEntityAttributes (415/404/409).
- Update a program's OU assignment → manage_metadata(action=update_program_org_units, merge_mode=replace|add|remove).
- "Broken / non-working rules" → manage_program_rules(action=audit) first, then bulk_fix_conditions. "Broken indicators" → manage_program_indicators(action=audit), then bulk_fix / bulk_fix_expressions.

### Expression grammars — follow the manual, do not guess
Program-rule conditions and program-indicator expressions use DIFFERENT restricted grammars with silent server-side failure modes (e.g. \`== false\` on booleans, \`d2:contains\` in a PI filter). The exact grammar, canonical patterns and forbidden functions are in the manuals of create_metadata / manage_program_rules / manage_program_indicators, delivered automatically on your first call to each — read them before writing any condition or expression, and never "fix" \`A{tea}\` into \`#{tea}\` (A{} is correct for attribute variables).
`;
  }

  // ── Metadata Management Protocol — deletion/removal operations ──
  if (wantsMetadataMgmt) {
    p += `
### Removing/Deleting Metadata — manage_metadata
⚠️ **NEVER** use dhis2_query with DELETE method for metadata objects. Use manage_metadata: remove_from_stage (detach a DE from a stage) → delete (reference-checked). Value-type conversions ("make this multi-select" / "text with multiple values") → manage_metadata(action=convert_value_type) — it cascades the DE + optionSet pair consistently; never PATCH one side only.
`;
  }

  // ── Icon / display style guidance ──
  if (wantsIconStyle) {
    p += `
### Icon / style updates — discover FIRST, then update_style
DHIS2 has a fixed ~900-icon library; obvious names like \`tuberculosis_positive\` DO NOT EXIST. MANDATORY: manage_metadata(action=discover_icons, keywords=[4-8 SHORT roots like "tb","respir","lung"]) first, then update_style with an EXACT key from the response (update_style refuses unverified keys). Icon search is prefix-on-keyword: \`preg\` matches, \`pregnancy\` returns 0. \`color\` needs no discovery. NEVER PATCH styles via dhis2_query (415).
`;
  }

  // ── Program Notifications (webhooks / email / SMS) ──
  if (wantsNotificationsPrompt) {
    p += `
### Program Notifications — manage_program_notifications
For any "create a webhook", "notify on enrollment/completion", "program notification template" request use manage_program_notifications — NEVER POST /api/programNotificationTemplates via dhis2_query (the payload shape and linking endpoint are non-obvious; historical 400/500 loops). The one-shot pattern is action="create_and_link" (atomic create + attach, auto-rollback, deduped) — never call create and link separately. Leftover templates → action="orphan_sweep".
`;
  }

  // ── Sharing & Access Protocol ──
  if (wantsSharingAccess) {
    p += `
### Sharing & Access — manage_metadata(action=update_sharing)
For "can't see / not appearing / no access" issues: (1) for programs in Capture/Tracker check \`program.organisationUnits\` FIRST — fix via manage_metadata(action=update_program_org_units); (2) then check the 8-char access string (positions 1-2 = metadata, 3-4 = data): \`"rw------"\` has NO data access (won't appear in Capture/Data Entry), \`"rwrw----"\` is full access. Also check sharing.userGroups. Fix via manage_metadata(action=update_sharing). ⚠️ NEVER PUT/PATCH sharing via dhis2_query (405/500).
`;
  }

  // ── Tool Selection Guide (compact, context-aware) ──
  p += `
## Tool Quick-Reference
| Question | Tool |
|---|---|
| Search metadata by name | search_metadata |
| Raw API read/write not covered above | dhis2_query |
`;
  if (inTrackerCtx) {
    p += `| How many enrolled/events? | count_records |
| Monthly/yearly trend | get_event_analytics(aggregate, period=LAST_12_MONTHS) |
| Breakdown by data element | get_event_analytics(aggregate, breakdown_dimension) |
| Recent metadata changes in a program | get_program_recent_changes |
| List people / TEI search | dhis2_query (tracker/trackedEntities) |
| Program rules/indicators | get_program_info |
| Resolve codes/IDs to names | resolve_option_codes |
| "How many with A AND B" | cross_stage_entity_intersection |
| Abnormal / quality scan | detect_enrollment_abnormalities |
`;
  }
  if (hasVizCtx)  p += `| Explain this chart/table | get_visualization_details |\n`;
  if (hasMapCtx)  p += `| Explain this map | get_map_details |\n`;
  if (browseWeb)  p += `| External / web search | browse_web |\n`;
  if (inspectSnapshot?.enabled) p += `| Explain captured page errors | inspect logs + DHIS2 tools |\n`;
  if (wantsChart) p += `| Render a chart | render_chart |\n`;
  if (isCreating) p += `| Create program (ONE call, all components) | create_metadata(action=create_program) |\n| Design/verify metadata | architect_metadata |\n`;
  if (isCreating || wantsSharingAccess) p += `| Update program OU assignment | manage_metadata(action=update_program_org_units) |\n`;
  if (inTrackerCtx || wantsProgramChangesPrompt) p += `| Program change history / recent modifications | get_program_recent_changes |\n`;
  if (isCreating || wantsProgramRulesPrompt) p += `| List/create/modify/delete program rules | manage_program_rules |\n`;
  if (isCreating || wantsProgramIndicatorsPrompt) p += `| List/create/modify/delete/audit program indicators | manage_program_indicators |\n`;
  if (wantsMetadataMgmt) p += `| Remove DE from stage / delete metadata | manage_metadata |\n`;
  if (wantsSharingAccess) p += `| Update sharing / fix access / fix visibility | manage_metadata(action=update_sharing) |\n`;
  if (wantsIconStyle) p += `| Discover real DHIS2 icon keys before applying | manage_metadata(action=discover_icons) |\n`;
  if (wantsIconStyle) p += `| Set icon / color on program, stage, DE, option set, TEA, indicator (after discover_icons) | manage_metadata(action=update_style) |\n`;
  if (wantsNotificationsPrompt) p += `| Create / link / edit webhook or email/SMS program notifications | manage_program_notifications |\n`;
  // Surface the backup tool whenever the user might want to undo/restore, OR
  // alongside any destructive tool so the model can confidently quote the key.
  const wantsBackupPrompt =
    /\b(backup|backups|snapshot|snapshots|restore|rollback|roll back|revert|undo|recover|recovery)\b/.test(text)
    || /\b(deleted|removed|changed|updated)\b.{0,40}\b(by mistake|accident|wrong|wrongly)\b/.test(text)
    || /\b(bring back|put back|get back)\b/.test(text);
  if (wantsBackupPrompt || isCreating || wantsMetadataMgmt || wantsSharingAccess || wantsIconStyle || wantsProgramRulesPrompt || wantsProgramIndicatorsPrompt || wantsNotificationsPrompt) {
    p += `| List / restore / delete metadata backups (auto-created before every destructive op) | manage_backups |\n`;
  }

  // ── Backup safety contract — applied whenever a destructive tool is in scope ──
  // Every update / delete on metadata auto-snapshots the *before* state to a
  // DHIS2 dataStore namespace. The model should ALWAYS surface the resulting
  // backup key so the user knows how to roll back; on a backup failure it must
  // ASK the user before proceeding (never set skip_backup:true unilaterally).
  const writeCapableInPrompt =
    isCreating || wantsMetadataMgmt || wantsSharingAccess ||
    wantsIconStyle || wantsProgramRulesPrompt ||
    wantsProgramIndicatorsPrompt || wantsNotificationsPrompt;
  if (writeCapableInPrompt) {
    p += `
## Auto-Backup Contract (destructive operations)
- BEFORE any update/delete on metadata (programs, stages, data elements, OUs, program rules, indicators, notifications, sharing, etc.) the tool snapshots the current state to dataStore namespace "${BACKUP_NAMESPACE}". A successful tool result includes a \`backup\` block with \`{ key, restore_hint, expires_in_days: ${BACKUP_RETENTION_DAYS} }\`.
- ALWAYS quote the backup key back to the user in your written summary, e.g. "Backup saved as \`<key>\` — restore with manage_backups(action=\\"restore\\", backup_key=\\"<key>\\")". Never hide it.
- If a tool returns \`_backup_failure: true\` and \`_requires_user_confirmation: true\`, STOP. Tell the user the snapshot step failed (use the \`_error\` and \`_hint\` from the result), and ask them whether to (a) abort the operation, or (b) proceed without recovery. ONLY retry the original write with \`skip_backup:true\` after the user gives an explicit "yes". Do not assume.
- For "undo / revert / rollback / I deleted X by mistake" requests, use \`manage_backups(action="list", limit=20, preview=true)\` to surface recent snapshots, then \`manage_backups(action="restore", backup_key="...")\`. Tombstones (objects already missing at snapshot time) are skipped on restore — that is normal.
- For bulk delete via dhis2_query: pass \`confirm_bulk_delete:true\` only after listing IDs and getting "yes". Above ${BULK_DELETE_SOFT_CAP} objects, also pass \`acknowledge_large_bulk:true\`.
`;
  }

  // ── Chart rules — only when charting is relevant ──
  if (wantsChart || hasVizCtx) {
    p += `
## Chart Type Rules
- Time trends → line or area | Categories → horizontal_bar | Parts of whole → pie (max 7) | Counts → bar | KPI → gauge | Stacked over time → stacked_bar
- Pass EXACT values from API. Use null for missing. MUST call render_chart — never describe it.
`;
  }

  if (hasImage) {
    p += `
## Image Analysis
The user's image has been analyzed; the description is under [Attached Image Analysis] in their message. Reference specific values and elements from the analysis in your response.
`;
  }

  p += `
## Response Format
- Use markdown tables for data with 2+ columns. Use **bold** for key terms. Headers for sections.
- Never show raw IDs. Keep responses concise and data-focused.
- For web-browsed answers include a "Sources" list with URLs.
`;

  if (ctx.appType === 'Line Listing') {
    const llLoaded = await ensureLineListingAssetsLoaded();
    let llBlocks = [];
    let llBlockIds = [];
    if (llLoaded) {
      llBlockIds = routeLineListingBlocks(userText, hasImage);
      llBlocks = loadLineListingBlocks(llBlockIds);
    }

    p += `

## Line Listing Priority
- You are in Line Listing context. Prefer row-level answers and reliability-first checks.
- When user asks about abnormalities, outliers, data quality issues, or enrollments needing attention:
  call detect_enrollment_abnormalities first, then summarize clearly with counts and examples.
- For Line Listing app UI/use questions (how to, filters, org units, export, troubleshooting), call line_listing_guide first.
`;

    if (llLoaded && llBlocks.length) {
      const compactRules = [
        'Start with a 1-sentence summary.',
        'Then give numbered click-by-click steps using exact UI labels.',
        'End with "Click Update" when instructions modify the line list.',
        'For screenshots: describe what is visible first, then the next steps.',
      ];
      const mdSnippet = lineListingAssets.systemPromptMd
        ? lineListingAssets.systemPromptMd.split('\n').slice(0, 40).join('\n')
        : '';
      p += `

## Line Listing Routed Blocks
- Routed block IDs: ${llBlockIds.join(', ')}
- Use ONLY these blocks for Line Listing UI guidance in this turn.
- Primary source: ${LINE_LISTING_JSON_PATH}
- Extra references loaded: ${LINE_LISTING_SYSTEM_PROMPT_PATH}, ${LINE_LISTING_ROUTER_PATH}

### Line Listing Guidance Rules
${compactRules.map(r => `- ${r}`).join('\n')}

### Line Listing System Prompt Snippet
${mdSnippet || '(not available)'}

### Routed Line Listing Blocks
${JSON.stringify(llBlocks, null, 2)}
`;
    }
  }

  return p;
}

