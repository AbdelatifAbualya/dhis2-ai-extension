/**
 * DHIS2 Line Listing Assistant — Chrome Extension Router Logic
 * 
 * This module handles:
 * 1. Loading the tool blocks from the JSON
 * 2. Routing user queries to the correct blocks
 * 3. Building minimal prompts for the LLM API call
 * 
 * Usage: Import this in your Chrome extension's background/content script.
 */

import toolData from './dhis2_linelisting_tool.json';

// ============================================================
// ROUTER: Maps user intent keywords to block IDs
// ============================================================

const KEYWORD_ROUTES = {
  // Intent patterns → Block IDs
  'what is line listing':       ['B00'],
  'what does this app do':      ['B00'],
  'purpose':                    ['B00'],
  
  'start':                      ['B01'],
  'new line list':              ['B01'],
  'blank':                      ['B01'],
  'open':                       ['B01'],
  'create':                     ['B01'],
  'begin':                      ['B01'],
  'from scratch':               ['B01'],
  
  'display':                    ['B02'],
  'show':                       ['B02'],
  'column':                     ['B02'],
  'add data':                   ['B02'],
  'data element':               ['B02'],
  'attribute':                  ['B02'],
  'indicator':                  ['B02'],
  
  'organisation unit':          ['B03'],
  'org unit':                   ['B03'],
  'facility':                   ['B03'],
  'district':                   ['B03'],
  'region':                     ['B03'],
  'hospital':                   ['B03'],
  'level':                      ['B03'],
  'health center':              ['B03'],
  
  'period':                     ['B04'],
  'time':                       ['B04'],
  'date':                       ['B04'],
  'month':                      ['B04'],
  'year':                       ['B04'],
  'quarter':                    ['B04'],
  'last 12':                    ['B04'],
  'this year':                  ['B04'],
  
  'filter':                     ['B05'],
  'condition':                  ['B05'],
  'narrow':                     ['B05'],
  'only show':                  ['B05'],
  'exclude':                    ['B05'],
  'greater than':               ['B05'],
  'equals':                     ['B05'],
  
  'enrollment':                 ['B06'],
  'cross-stage':                ['B06'],
  'multiple stages':            ['B06'],
  'across stages':              ['B06'],
  
  'repeat':                     ['B07'],
  'repeatable':                 ['B07'],
  'multiple visits':            ['B07'],
  'repeated event':             ['B07'],
  
  'color':                      ['B08'],
  'legend':                     ['B08'],
  'scorecard':                  ['B08'],
  'highlight':                  ['B08'],
  
  'save':                       ['B09'],
  'download':                   ['B09'],
  'export':                     ['B09'],
  'share':                      ['B09'],
  'csv':                        ['B09'],
  'excel':                      ['B09'],
  
  'rounding':                   ['B10'],
  'decimal':                    ['B10'],
  'hierarchy':                  ['B10'],
  'full screen':                ['B10'],
  'options':                    ['B10'],
  
  'empty':                      ['B11'],
  'error':                      ['B11'],
  'not working':                ['B11'],
  'missing':                    ['B11'],
  'no data':                    ['B11'],
  'broken':                     ['B11'],
  'greyed out':                 ['B11'],
  
  'boolean':                    ['B13'],
  'data type':                  ['B13'],
  'operator':                   ['B13'],
  'option set':                 ['B13'],
};

// ============================================================
// FUNCTIONS
// ============================================================

/**
 * Route a text query to the relevant block IDs.
 * Returns an array of block IDs to load.
 */
function routeQuery(userMessage) {
  const msg = userMessage.toLowerCase();
  const matchedBlocks = new Set();

  for (const [keyword, blockIds] of Object.entries(KEYWORD_ROUTES)) {
    if (msg.includes(keyword)) {
      blockIds.forEach(id => matchedBlocks.add(id));
    }
  }

  // If it's a screenshot (detected by the extension), always include B12
  // The extension should set a flag or detect image input
  // if (isScreenshot) matchedBlocks.add('B12');

  // Default: if no match, assume user needs to start from scratch
  if (matchedBlocks.size === 0) {
    matchedBlocks.add('B01');
  }

  // Always include B01 if user seems to need a full workflow
  if (matchedBlocks.has('B02') || matchedBlocks.has('B03') || matchedBlocks.has('B04')) {
    // Check if they likely need the setup step too
    if (msg.includes('how do i') || msg.includes('i want to') || msg.includes('help me')) {
      matchedBlocks.add('B01');
    }
  }

  return [...matchedBlocks].sort();
}

/**
 * Load only the specified blocks from the tool JSON.
 * Returns a compact string to inject into the LLM prompt.
 */
function loadBlocks(blockIds) {
  const blocks = [];
  for (const id of blockIds) {
    const block = toolData.blocks[id];
    if (block) {
      blocks.push(block);
    }
  }
  return blocks;
}

/**
 * Build the final LLM prompt with only the relevant blocks injected.
 * This is what gets sent to the API (e.g., Anthropic, OpenAI).
 */
function buildPrompt(userMessage, isScreenshot = false) {
  // Step 1: Route
  const blockIds = routeQuery(userMessage);
  if (isScreenshot) blockIds.push('B12');

  // Step 2: Load blocks
  const blocks = loadBlocks([...new Set(blockIds)]);

  // Step 3: Build the system message with ONLY relevant blocks
  const systemPrompt = `You are a DHIS2 Line Listing Assistant. Help the user with their question using ONLY the reference blocks below. Give click-by-click instructions. Be concise.

REFERENCE BLOCKS:
${JSON.stringify(blocks, null, 2)}

RULES:
- Start with a 1-sentence summary.
- Give numbered, click-by-click steps using exact UI element names.
- Always end with "Click 'Update' to generate/refresh the table" when applicable.
- If the user needs to do something not covered in the blocks, say so and suggest checking DHIS2 docs.
- For screenshots: first describe what you see, then give next steps.`;

  return {
    system: systemPrompt,
    user: userMessage,
    blockIds: blockIds,
    tokenEstimate: Math.ceil(systemPrompt.length / 4) // rough token count
  };
}


// ============================================================
// EXPORT
// ============================================================

export { routeQuery, loadBlocks, buildPrompt };


// ============================================================
// EXAMPLE USAGE
// ============================================================

/*
// Text question:
const result = buildPrompt("How do I display patient name and diagnosis for Central Hospital?");
console.log(result.blockIds);     // ['B01', 'B02', 'B03']
console.log(result.tokenEstimate); // ~800 tokens (vs ~4000 for full tool)

// Screenshot:
const result2 = buildPrompt("What should I do next?", true);
console.log(result2.blockIds);     // ['B01', 'B12']

// Then send to your LLM API:
const response = await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system: result.system,
    messages: [{ role: 'user', content: result.user }]
  })
});
*/
