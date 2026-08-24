import type { YahooReadGateway } from "./read.js";

export type YahooFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface YahooHttpReadGatewayOptions {
  accessToken: string;
  fetch?: YahooFetch;
}

export class YahooHttpReadGateway implements YahooReadGateway {
  readonly #accessToken: string;
  readonly #fetch: YahooFetch;

  constructor(options: YahooHttpReadGatewayOptions) {
    if (!options.accessToken.trim()) {
      throw new Error("A Yahoo access token is required.");
    }

    this.#accessToken = options.accessToken;
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  async #get(path: string): Promise<unknown> {
    const response = await this.#fetch(`https://fantasysports.yahooapis.com/fantasy/v2/${path}?format=json`, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.#accessToken}`
      }
    });

    if (!response.ok) {
      throw new Error(`Yahoo read failed with status ${response.status}.`);
    }

    return response.json();
  }

  async readLeague(leagueKey: string): Promise<unknown> {
    return this.#get(`league/${encodeURIComponent(leagueKey)}`);
  }

  async readTeamRoster(teamKey: string): Promise<unknown> {
    return this.#get(`team/${encodeURIComponent(teamKey)}/roster`);
  }
}
