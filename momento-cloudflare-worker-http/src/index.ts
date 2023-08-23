import { Hono } from 'hono'
import { logger } from 'hono/logger'
import type { Context } from 'hono'
import {
	CacheClient, CacheDelete,
	CacheGet, CacheSet,
	Configurations, CreateCache,
	CredentialProvider,
} from "@gomomento/sdk-web"
import XMLHttpRequestPolyfill from "xhr4sw"


type Bindings = {
  ORIGIN_HOST: string
  MOMENTO_REST_ENDPOINT: string
  MOMENTO_CACHE_NAME: string
  MOMENTO_AUTH_TOKEN: string
}

type Metadata = {
  headers: Record<string, string>
}

Object.defineProperty(self, 'XMLHttpRequest', {
	configurable: false,
	enumerable: true,
	writable: false,
	value: XMLHttpRequestPolyfill
});

export interface Env {
	MOMENTO_AUTH_TOKEN: string;
	MOMENTO_CACHE_NAME: string;
}

class MomentoFetcher {
	private readonly momento: CacheClient;

	constructor(client: CacheClient) {
		this.momento = client;
	}

	async get(cacheName: string, key: string) {
		const getResponse = await this.momento.get(cacheName, key);
		if (getResponse instanceof CacheGet.Hit) {
			console.log(`cache hit: ${getResponse.valueString()}`);
		} else if (getResponse instanceof CacheGet.Miss) {
			console.log(`cache miss for key ${key}`);
		} else if (getResponse instanceof CacheGet.Error) {
			console.log(`Error when getting value from cache! ${getResponse.toString()}`);
			throw new Error(`Error retrieving key ${key}: ${getResponse.message()}`);
		}

		return getResponse;
	}

	async set(cacheName: string, key: string, value: string, ttl_seconds: number = 30) {
		const setResponse = await this.momento.set(cacheName, key, value, {
			ttl: ttl_seconds,
		});

		if (setResponse instanceof CacheSet.Success) {
			console.log('Key stored successfully!');
		} else if (setResponse instanceof CacheSet.Error) {
			console.log(`Error when setting value in cache! ${setResponse.toString()}`);
			throw new Error(`Error setting key ${key}: ${setResponse.toString()}`);
		}

		return;
	}

	async delete(cacheName: string, key: string) {
		const delResponse = await this.momento.delete(cacheName, key);
		if (delResponse instanceof CacheDelete.Success) {
			console.log(`successfully deleted ${key} from cache`);
		} else if (delResponse instanceof CacheDelete.Error) {
			console.log(`Error when deleting value from cache! ${delResponse.toString()}`);
			throw new Error(`failed to delete ${key} from cache. Message: ${delResponse.message()}; cache: ${cacheName}`);
		}

		return;
	}
}

const ttl = 60
const staleTtl = 60 * 60

const app = new Hono<{ Bindings: Bindings }>()


app.use('*', logger())

const createCache = async (
  c: Context<'/', { Bindings: Bindings }>,
  originURL: string,
  response?: Response
) => {
  if (!response) {
    console.log(`fetch from ${originURL}`)
    response = await fetch(originURL)
  }
  const body = await response.toString()

  const momento = new CacheClient({
    configuration: Configurations.Laptop.v1(),
    credentialProvider: CredentialProvider.fromString({
      authToken:c.env.MOMENTO_AUTH_TOKEN
    }),
    defaultTtlSeconds: 60,
  });

  const client = new MomentoFetcher(momento);
  const cache = c.env.MOMENTO_CACHE_NAME;

  console.log(`store stale: ${originURL}`)
  await client.set(cache, `stale: ${originURL}`, body, staleTtl);

  console.log(`store fresh: ${originURL}`)
  await client.set(cache, `fresh: ${originURL}`, body, ttl);
}

app.get('/posts/', async (c) => {
  const momento = new CacheClient({
    configuration: Configurations.Laptop.v1(),
    credentialProvider: CredentialProvider.fromString({
      authToken:c.env.MOMENTO_AUTH_TOKEN
    }),
    defaultTtlSeconds: 60,
  });

  const client = new MomentoFetcher(momento);
  const cache = c.env.MOMENTO_CACHE_NAME;
  const originURL = `https://${c.env.ORIGIN_HOST}/posts/`

  console.log(`try to get ${originURL} from momento`)
  const getResponse = await client.get(cache, `fresh: ${originURL}`)
  let response: Response

  if (getResponse instanceof CacheGet.Hit) {
    console.log(`${originURL} already is stored`)
    const getResponseString = getResponse.valueUint8Array()
    response = new Response(getResponseString)
  } else {
    const getResponse = await client.get(cache, `stale: ${originURL}`)
    if (getResponse instanceof CacheGet.Hit) {
      console.log(`${originURL} is expired but the stale is found`)
      const getResponseString = getResponse.valueUint8Array()
      response = new Response(getResponseString)
      c.executionCtx.waitUntil(createCache(c, originURL))
    } else {
      console.log(`fetch from ${originURL}`)
      response = await fetch(originURL)
      c.executionCtx.waitUntil(createCache(c, originURL, response))
    }
  }

  return response
})

app.delete('/posts/', async (c) => {
  const momento = new CacheClient({
    configuration: Configurations.Laptop.v1(),
    credentialProvider: CredentialProvider.fromString({
      authToken:c.env.MOMENTO_AUTH_TOKEN
    }),
    defaultTtlSeconds: 60,
  });

  const client = new MomentoFetcher(momento);
  const cache = c.env.MOMENTO_CACHE_NAME;
  const originURL = `https://${c.env.ORIGIN_HOST}/posts/`
  // Force delete
  await client.delete(cache, `fresh: ${originURL}`)
  await client.delete(cache, `stale: ${originURL}`)
  return c.redirect('/posts/')
})

app.get('/posts/*', async (c) => {
  const url: URL = new URL(c.req.url)
  const originURL = `https://${c.env.ORIGIN_HOST}${url.pathname}`
  console.log(`fetch from ${originURL}`)
  const response = await fetch(originURL)
  return new Response(response.body, response)
})

export default app
