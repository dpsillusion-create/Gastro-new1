import { config } from './config';
import { createApp } from './app';

createApp().listen(config.port, () => console.log(`SmartShift API auf :${config.port}`));
