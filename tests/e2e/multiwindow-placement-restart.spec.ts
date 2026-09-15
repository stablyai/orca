import { test } from './helpers/orca-app'
import { multiwindowRestartJourney } from './helpers/multiwindow-restart-journey'

test(
  'restores a secondary window identity and its own placement after application restart',
  multiwindowRestartJourney
)
