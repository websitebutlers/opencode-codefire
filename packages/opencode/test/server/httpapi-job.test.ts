import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { BackgroundJob } from "@/background/job"
import { Server } from "../../src/server/server"
import * as Log from "@opencode-ai/core/util/log"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffectShared } from "../lib/effect"

void Log.init({ print: false })

const it = testEffectShared(Layer.mergeAll(BackgroundJob.defaultLayer))

function request(path: string, directory: string, init: RequestInit = {}) {
  return Effect.promise(() => {
    const headers = new Headers(init.headers)
    headers.set("x-opencode-directory", directory)
    return Promise.resolve(Server.Default().app.request(path, { ...init, headers }))
  })
}

function json<T>(response: Response) {
  return Effect.promise(() => response.json() as Promise<T>)
}

describe("httpapi.job", () => {
  afterEach(() => disposeAllInstances())

  it.instance("lists background jobs and filters by groupID", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const jobs = yield* BackgroundJob.Service
      yield* jobs.start({ id: "job_http_a", type: "test", groupID: "grp_http", run: Effect.never })
      yield* jobs.start({ id: "job_http_b", type: "test", run: Effect.never })

      const all = yield* request("/experimental/job", test.directory)
      expect(all.status).toBe(200)
      const allBody = yield* json<BackgroundJob.Info[]>(all)
      expect(allBody.map((job) => job.id).toSorted()).toEqual(["job_http_a", "job_http_b"])

      const grouped = yield* request("/experimental/job?groupID=grp_http", test.directory)
      const groupedBody = yield* json<BackgroundJob.Info[]>(grouped)
      expect(groupedBody.length).toBe(1)
      expect(groupedBody[0].id).toBe("job_http_a")
      expect(groupedBody[0].status).toBe("running")

      yield* jobs.cancel("job_http_a")
      yield* jobs.cancel("job_http_b")
    }),
  )

  it.instance("gets a job by id and 404s on unknown ids", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const jobs = yield* BackgroundJob.Service
      yield* jobs.start({ id: "job_http_get", type: "test", run: Effect.succeed("done") })
      yield* jobs.wait({ id: "job_http_get" })

      const found = yield* request("/experimental/job/job_http_get", test.directory)
      expect(found.status).toBe(200)
      const body = yield* json<BackgroundJob.Info>(found)
      expect(body.id).toBe("job_http_get")
      expect(body.status).toBe("completed")
      expect(body.output).toBe("done")

      const missing = yield* request("/experimental/job/job_does_not_exist", test.directory)
      expect(missing.status).toBe(404)
    }),
  )

  it.instance("cancels a running job", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const jobs = yield* BackgroundJob.Service
      yield* jobs.start({ id: "job_http_cancel", type: "test", run: Effect.never })

      const response = yield* request("/experimental/job/job_http_cancel/cancel", test.directory, { method: "POST" })
      expect(response.status).toBe(200)
      const body = yield* json<BackgroundJob.Info>(response)
      expect(body.status).toBe("cancelled")

      expect((yield* jobs.get("job_http_cancel"))?.status).toBe("cancelled")
    }),
  )
})
