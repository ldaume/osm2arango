export interface InstallPlan {
  name: string
  steps: string[][]
}

export type WhichFn = (cmd: string) => string | null

export function detectOsmiumInstallPlan(platform: string, which: WhichFn): InstallPlan | undefined {
  if (platform === 'darwin' && which('brew')) {
    return {
      name: 'Homebrew',
      steps: [['brew', 'install', 'osmium-tool']],
    }
  }

  if (platform === 'linux' && which('apt-get')) {
    return {
      name: 'apt-get',
      steps: [
        ['sudo', 'apt-get', 'update'],
        ['sudo', 'apt-get', 'install', '-y', 'osmium-tool'],
      ],
    }
  }

  if (platform === 'linux' && which('pacman')) {
    return {
      name: 'pacman',
      steps: [['sudo', 'pacman', '-S', 'osmium-tool']],
    }
  }

  return undefined
}

export function formatInstallPlan(plan: InstallPlan): string {
  return plan.steps.map(step => step.join(' ')).join('\n')
}
