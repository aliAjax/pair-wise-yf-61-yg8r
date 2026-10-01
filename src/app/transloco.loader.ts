import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type { Observable } from 'rxjs';
import type { TranslocoLoader } from '@jsverse/transloco';

type TranslationMap = Record<string, unknown>;

@Injectable({ providedIn: 'root' })
export class AppTranslocoLoader implements TranslocoLoader {
  private readonly http = inject(HttpClient);

  getTranslation(lang: string): Observable<TranslationMap> {
    return this.http.get<TranslationMap>(`/i18n/${lang}.json`);
  }
}
