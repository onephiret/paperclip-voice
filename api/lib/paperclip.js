// Paperclip API tool definitions and executor for Gemini function calling

const PAPERCLIP_API_URL = process.env.PAPERCLIP_API_URL || 'http://127.0.0.1:3100';
const PAPERCLIP_API_KEY = process.env.PAPERCLIP_VOICE_API_KEY;
const PAPERCLIP_COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID;

function paperclipHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${PAPERCLIP_API_KEY}`,
  };
}

async function paperclipFetch(path, options = {}) {
  const res = await fetch(`${PAPERCLIP_API_URL}${path}`, {
    ...options,
    headers: { ...paperclipHeaders(), ...(options.headers || {}) },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Paperclip API ${res.status}: ${text}`);
  }
  return res.json();
}

async function getInbox() {
  return paperclipFetch('/api/agents/me/inbox-lite');
}

async function createIssue({ title, description, priority }) {
  return paperclipFetch(`/api/companies/${PAPERCLIP_COMPANY_ID}/issues`, {
    method: 'POST',
    body: JSON.stringify({
      title,
      description: description || '',
      priority: priority || 'medium',
      status: 'todo',
    }),
  });
}

async function updateIssue({ identifier, status, comment }) {
  const body = {};
  if (status) body.status = status;
  if (comment) body.comment = comment;
  return paperclipFetch(`/api/issues/${identifier}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

async function addComment({ identifier, comment }) {
  return paperclipFetch(`/api/issues/${identifier}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body: comment }),
  });
}

async function getIssue({ identifier }) {
  return paperclipFetch(`/api/issues/${identifier}`);
}

async function searchIssues({ query }) {
  return paperclipFetch(
    `/api/companies/${PAPERCLIP_COMPANY_ID}/issues?q=${encodeURIComponent(query)}&status=todo,in_progress,in_review,blocked`
  );
}

const FUNCTION_MAP = {
  get_inbox: getInbox,
  create_issue: createIssue,
  update_issue: updateIssue,
  add_comment: addComment,
  get_issue: getIssue,
  search_issues: searchIssues,
};

async function executeTool(name, args) {
  const fn = FUNCTION_MAP[name];
  if (!fn) throw new Error(`Unknown tool: ${name}`);
  try {
    const result = await fn(args || {});
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

const TOOL_DECLARATIONS = [
  {
    name: 'get_inbox',
    description: "Get Dan's current task inbox and agenda — all assigned open issues.",
    parameters: { type: 'OBJECT', properties: {}, required: [] },
  },
  {
    name: 'create_issue',
    description: 'Create a new task or issue in Paperclip.',
    parameters: {
      type: 'OBJECT',
      properties: {
        title: { type: 'STRING', description: 'Short title for the task.' },
        description: { type: 'STRING', description: 'Optional detail about the task.' },
        priority: {
          type: 'STRING',
          description: 'Priority: critical, high, medium, or low. Default medium.',
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'update_issue',
    description: 'Update the status of an existing task, optionally adding a comment.',
    parameters: {
      type: 'OBJECT',
      properties: {
        identifier: { type: 'STRING', description: 'Issue identifier like ONE-42.' },
        status: {
          type: 'STRING',
          description: 'New status: todo, in_progress, in_review, done, blocked, cancelled.',
        },
        comment: { type: 'STRING', description: 'Optional comment to add when updating.' },
      },
      required: ['identifier'],
    },
  },
  {
    name: 'add_comment',
    description: 'Add a comment to an existing task.',
    parameters: {
      type: 'OBJECT',
      properties: {
        identifier: { type: 'STRING', description: 'Issue identifier like ONE-42.' },
        comment: { type: 'STRING', description: 'The comment text to add.' },
      },
      required: ['identifier', 'comment'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get full details about a specific task by identifier.',
    parameters: {
      type: 'OBJECT',
      properties: {
        identifier: { type: 'STRING', description: 'Issue identifier like ONE-42.' },
      },
      required: ['identifier'],
    },
  },
  {
    name: 'search_issues',
    description: 'Search for tasks by keyword across titles, descriptions, and comments.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: { type: 'STRING', description: 'Search terms.' },
      },
      required: ['query'],
    },
  },
];

// Run a Gemini chat turn with function calling support.
// Returns the final text response after executing any tool calls.
async function runWithTools(chat, userMessage) {
  let result = await chat.sendMessage(userMessage);

  for (let i = 0; i < 5; i++) {
    const parts = result.response.candidates?.[0]?.content?.parts || [];
    const callParts = parts.filter((p) => p.functionCall);

    if (callParts.length === 0) break;

    const responses = await Promise.all(
      callParts.map(async (p) => {
        const toolResult = await executeTool(p.functionCall.name, p.functionCall.args);
        return {
          functionResponse: {
            name: p.functionCall.name,
            response: toolResult,
          },
        };
      })
    );

    result = await chat.sendMessage(responses);
  }

  return result.response.text().trim();
}

module.exports = { TOOL_DECLARATIONS, runWithTools };
