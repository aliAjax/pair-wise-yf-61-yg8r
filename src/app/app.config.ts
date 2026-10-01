import { ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { provideStore } from '@ngrx/store';
import { provideHttpClient } from '@angular/common/http';
import { provideTransloco } from '@jsverse/transloco';
import { AppTranslocoLoader } from './transloco.loader';
import { releaseReducer } from './state/release.reducer';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter([]),
    provideAnimationsAsync(),
    provideHttpClient(),
    provideStore({ release: releaseReducer }),
    provideTransloco({
      config: { availableLangs: ['zh'], defaultLang: 'zh', reRenderOnLangChange: true, prodMode: true },
      loader: AppTranslocoLoader
    })
  ]
};
