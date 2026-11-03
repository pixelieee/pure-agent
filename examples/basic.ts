import { createAgent } from '../src/index.ts';
import { createOpenAIModel } from '../src/providers/openai.ts';

// Real provider example. Credentials come only from the host environment.
if (!process.env.OPENAI_API_KEY) throw new Error('Set OPENAI_API_KEY before running this example.');
const agent = createAgent({
  model: createOpenAIModel({ apiKey: process.env.OPENAI_API_KEY, model: 'gpt-5.6-luna', reasoningEffort: 'low' }),
  system: 'Answer concisely and honestly.',
});
const result = await agent.run(process.argv.slice(2).join(' ') || 'Explain what an agent tool call does.');
console.log(result.text);
if (result.status !== 'completed') process.exitCode = 1;
