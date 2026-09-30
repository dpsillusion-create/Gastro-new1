import { config, validateConfig } from './config';
import { createApp } from './app';

validateConfig();
createApp().listen(config.port, () => console.log(`SmartShift API auf :${config.port}`));
