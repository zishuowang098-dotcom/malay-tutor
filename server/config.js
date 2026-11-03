import 'dotenv/config';
import path from 'node:path';

export const config = {
  port: Number(process.env.PORT || 3000),
  dataDir: path.resolve(process.env.DATA_DIR || './data'),
  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
  model: process.env.CLAUDE_MODEL || 'claude-opus-5-5',
  azureKey: process.env.AZURE_SPEECH_KEY || '',
  azureRegion: process.env.AZURE_SPEECH_REGION || '',
  appPassword: process.env.APP_PASSWORD || '',
};

export function status() {
  return {
    ai: Boolean(config.anthropicKey),
    speech: Boolean(config.azureKey && config.azureRegion),
    model: config.model,
    authRequired: Boolean(config.appPassword),
  };
}
