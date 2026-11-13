// The workstation's modules. `built: false` modules have a tab and an honest page saying what they will do
// and where they are in the build order (the owner asked for the whole layout to be set up ahead of the tools).
export interface ModuleInfo { id: string; name: string; built: boolean; order?: number; what?: string; will?: string[]; today?: string; needs?: string }

export const MODULES: ModuleInfo[] = [
  { id: 'studio', name: 'Sampler', built: true },
  { id: 'clips', name: 'Clips', built: true },
  { id: 'arrange', name: 'Arrange', built: true },
  { id: 'mixer', name: 'Mixer', built: true },
  { id: 'analyze', name: 'Analyze', built: true },
  { id: 'stems', name: 'Stems', built: false, order: 1,
    what: 'Split a song into vocals, drums, bass and everything else.',
    will: ['A Split button on any sample', 'Each part arrives as its own sample, ready to chop', 'Runs on your own PC, or through Suno for songs in your Suno library'],
    needs: 'A choice of where the splitting runs: your GPU PC (free, needs a one-time setup) or Suno (costs credits).',
    today: 'Split the song in Suno or another tool, then import each part here, or use Analyze to pull loops, hits and vocal lines from the full song.' },
  { id: 'suno', name: 'Suno', built: true },
  { id: 'ai', name: 'AI setup', built: false, order: 2,
    what: 'Choose which AI runs the Assistant, and give it your own instructions and documents.',
    will: ['Use Google Gemini, GPT or a model on your own PC by pasting a key, with step-by-step instructions', 'A shelf for PDFs, instructions and saved workflows the Assistant reads', 'Research mode: study an artist\'s production style and turn it into steps'],
    today: 'The Assistant runs on Claude: your own Claude account in the Claude page, or an Anthropic key on the web link.' },
  { id: 'plugins', name: 'Plugins', built: false, order: 3,
    what: 'Load instrument and effect plugins for sounds beyond the built-in ones.',
    will: ['Free VST and CLAP plugins on any track', 'Built-in synths and drum machines in the meantime'],
    needs: 'The desktop version of the studio. No web browser can load VST plugins.',
    today: 'Filter, drive, echo, reverb, stretch, scatter and stutter on the FX tab, and Resample to stack them.' },
];
