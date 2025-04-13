import { INestApplication } from "@nestjs/common"
import { WsAdapter } from "@nestjs/platform-ws"
import { Test } from "@nestjs/testing"
import { StartedPostgreSqlContainer } from "@testcontainers/postgresql"
import { RedisContainer, StartedRedisContainer } from "@testcontainers/redis"
import fs from "fs/promises"
import { transit_realtime as GtfsRt } from "gtfs-realtime-bindings"
import path from "path"
import { AppModule } from "src/app.module"
import { FeedSyncService } from "src/modules/feed/feed-sync.service"
import { TripDto } from "src/schedule/schedule.controller"
import request from "supertest"
import { promisify } from "util"
import { setupFakeGtfsServer } from "./helpers/gtfs-server"
import { setupTestDatabase } from "./helpers/postgres"

describe("E2E test", () => {
  let postgresContainer: StartedPostgreSqlContainer
  let redisContainer: StartedRedisContainer
  let fakeGtfs: Awaited<ReturnType<typeof setupFakeGtfsServer>>
  let app: INestApplication

  beforeAll(async () => {
    const { postgresContainer: pgContainer, connectionUrl } =
      await setupTestDatabase()

    postgresContainer = pgContainer
    process.env.DATABASE_URL = connectionUrl.toString()

    redisContainer = await new RedisContainer().start()
    process.env.REDIS_URL = redisContainer.getConnectionUrl()

    process.env.FEEDS_CONFIG = await fs.readFile(
      path.join(__dirname, "fixtures", "feeds.test.yaml"),
      "utf-8",
    )

    fakeGtfs = await setupFakeGtfsServer()

    process.env.DISABLE_RATE_LIMITS = "true"

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile()

    app = moduleRef.createNestApplication()
    app.useWebSocketAdapter(new WsAdapter(app))
    await app.init()

    await app.get(FeedSyncService).syncAllFeeds()
  }, 120_000)

  afterAll(async () => {
    await app.close()
    await Promise.all([
      postgresContainer.stop(),
      redisContainer.stop(),
      promisify(fakeGtfs.server.close).bind(fakeGtfs.server)(),
    ])
  })

  test("GET /feeds", async () => {
    const response = await request(app.getHttpServer())
      .get("/feeds")
      .expect("Content-Type", /json/)
      .expect(200)

    expect(response.body).toHaveLength(1)

    const feed = response.body[0]

    expect(feed.lastSyncedAt).toBeDefined()

    const now = new Date().getTime()
    const lastSyncedAt = new Date(feed.lastSyncedAt).getTime()
    expect(lastSyncedAt).toBeLessThanOrEqual(now)
    expect(lastSyncedAt).toBeGreaterThanOrEqual(
      now - 300_000, // 5 minutes
    )

    expect(feed.code).toBe("testfeed")
    expect(feed.name).toBe("Test Feed")
    expect(feed.description).toBe("Test Feed Description")
    expect(feed.bounds).toEqual([-117.13316, 36.42529, -116.40094, 36.915684])
  })

  test("GET /feeds/service-areas", async () => {
    const response = await request(app.getHttpServer())
      .get("/feeds/service-areas")
      .expect("Content-Type", /json/)
      .expect(200)

    expect(response.body).toMatchSnapshot()
  })

  test("GET /stops/within/:bbox", async () => {
    const response = await request(app.getHttpServer())
      .get("/stops/within/-116.774095,36.909629,-116.760877,36.917066")
      .expect("Content-Type", /json/)
      .expect(200)

    expect(response.body).toHaveLength(2)
    expect(response.body).toMatchSnapshot()
  })

  test("GET /stops/:id/routes", async () => {
    const response = await request(app.getHttpServer())
      .get("/stops/testfeed:AMV/routes")
      .expect("Content-Type", /json/)
      .expect(200)

    expect(response.body).toHaveLength(1)
    expect(response.body).toMatchSnapshot()
  })

  describe("GET /schedule/:routeStopPairs", () => {
    let dateSpy: jest.SpyInstance<number, [], any>

    beforeEach(() => {
      dateSpy = jest.spyOn(Date, "now")
      dateSpy.mockImplementation(() =>
        new Date("2008-01-04T13:30:00Z").getTime(),
      )
    })

    afterEach(() => {
      dateSpy.mockRestore()
    })

    async function getTripSchedule(
      scheduleString: string = "testfeed:AAMV,testfeed:BEATTY_AIRPORT;testfeed:STBA,testfeed:STAGECOACH",
    ) {
      const response = await request(app.getHttpServer())
        .get(`/schedule/${scheduleString}`)
        .expect("Content-Type", /json/)
        .expect(200)

      expect(response.body).toHaveProperty("trips")
      return response.body.trips as TripDto[]
    }

    test("with static schedule", async () => {
      const trips = await getTripSchedule()
      expect(trips).toMatchSnapshot()
    })

    test("with service exception in static schedule", async () => {
      dateSpy.mockImplementation(() =>
        new Date("2007-06-04T13:30:00Z").getTime(),
      )

      const trips = await getTripSchedule()
      expect(trips).toMatchSnapshot()

      // Expect trip for the 4th to be skipped
      expect(new Date(trips[0].arrivalTime * 1000).getUTCDate()).toBe(5)
    })

    test("with interpolated stop_times", async () => {
      const trips = await getTripSchedule("testfeed:CITY,testfeed:NADAV")

      const interpolatedTrip = trips.find((t) => t.tripId === "testfeed:CITY2")

      expect(interpolatedTrip).toBeDefined()

      const arrival = new Date(interpolatedTrip!.arrivalTime * 1000)
      expect(arrival.getUTCHours()).toBe(15)
      expect(arrival.getUTCMinutes()).toBe(42)
      expect(arrival.getUTCSeconds()).toBe(0)

      expect(interpolatedTrip!.arrivalTime).toBe(
        interpolatedTrip!.departureTime,
      )
    })

    test("with frequency-based trip", async () => {
      const trips = await getTripSchedule("testfeed:AB,testfeed:BEATTY_AIRPORT")

      // We want to skip frequency-based trips for now since they are unsupported
      expect(trips.some((trip) => trip.tripId === "testfeed:AB1")).toBe(false)
    })

    describe("with GTFS-RT updates", () => {
      afterEach(() => {
        fakeGtfs.setTripUpdates([])
        fakeGtfs.setSimulateTripUpdatesFailure(false)
      })

      test("falls back to static schedule if GTFS-RT fails", async () => {
        fakeGtfs.setSimulateTripUpdatesFailure(true)

        const trips = await getTripSchedule()
        expect(trips.length).toBeGreaterThan(0)
        expect(trips).toMatchSnapshot()
      })

      test("with same trip on multiple days", async () => {
        fakeGtfs.setTripUpdates([
          {
            trip: {
              tripId: "STBA",
              startDate: "20080104",
              scheduleRelationship:
                GtfsRt.TripDescriptor.ScheduleRelationship.SCHEDULED,
            },
            stopTimeUpdate: [
              {
                stopId: "STAGECOACH",
                arrival: {
                  time: 1199455200,
                },
              },
            ],
          },
          {
            trip: {
              tripId: "STBA",
              startDate: "20080105",
              scheduleRelationship:
                GtfsRt.TripDescriptor.ScheduleRelationship.SCHEDULED,
            },
            stopTimeUpdate: [
              {
                stopId: "STAGECOACH",
                arrival: {
                  time: 1199541600,
                },
              },
            ],
          },
        ])

        const trips = await getTripSchedule()
        const updatedTrips = trips.filter(
          (trip) => trip.tripId === "testfeed:STBA",
        )

        expect(updatedTrips).toHaveLength(2)

        expect(updatedTrips[0].arrivalTime).toBe(1199455200)
        expect(updatedTrips[0].isRealtime).toBe(true)

        expect(updatedTrips[1].arrivalTime).toBe(1199541600)
        expect(updatedTrips[1].isRealtime).toBe(true)
      })

      test("with same trip on multiple days using ambiguous start_date", async () => {
        fakeGtfs.setTripUpdates([
          {
            trip: {
              tripId: "STBA",
              scheduleRelationship:
                GtfsRt.TripDescriptor.ScheduleRelationship.SCHEDULED,
            },
            stopTimeUpdate: [
              {
                stopId: "STAGECOACH",
                arrival: {
                  time: 1199455200,
                },
              },
            ],
          },
        ])

        const trips = await getTripSchedule()
        const updatedTrips = trips.filter(
          (trip) => trip.tripId === "testfeed:STBA",
        )

        expect(updatedTrips).toHaveLength(2)

        expect(updatedTrips[0].arrivalTime).toBe(1199455200)
        expect(updatedTrips[0].isRealtime).toBe(true)

        expect(updatedTrips[1].arrivalTime).toBe(1199541600)
        expect(updatedTrips[1].isRealtime).toBe(false)
      })

      test("with cancelled trip on multiple days using ambiguous start_date", async () => {
        fakeGtfs.setTripUpdates([
          {
            trip: {
              tripId: "STBA",
              scheduleRelationship:
                GtfsRt.TripDescriptor.ScheduleRelationship.CANCELED,
            },
          },
        ])

        const trips = await getTripSchedule()
        const remainingUncancelledTrips = trips.filter(
          (trip) => trip.tripId === "testfeed:STBA",
        )

        // Expect that we have only cancelled one of the two STBA trips
        expect(remainingUncancelledTrips).toHaveLength(1)
        expect(remainingUncancelledTrips[0].arrivalTime).toBe(1199541600)
      })

      test("with skipped stop on multiple days using ambiguous start_date", async () => {
        fakeGtfs.setTripUpdates([
          {
            trip: {
              tripId: "STBA",
              scheduleRelationship:
                GtfsRt.TripDescriptor.ScheduleRelationship.SCHEDULED,
            },
            stopTimeUpdate: [
              {
                stopId: "STAGECOACH",
                scheduleRelationship:
                  GtfsRt.TripUpdate.StopTimeUpdate.ScheduleRelationship.SKIPPED,
              },
            ],
          },
        ])

        const trips = await getTripSchedule()
        const remainingUncancelledTrips = trips.filter(
          (trip) => trip.tripId === "testfeed:STBA",
        )

        // Expect that we have only cancelled one of the two STBA trips
        expect(remainingUncancelledTrips).toHaveLength(1)
        expect(remainingUncancelledTrips[0].arrivalTime).toBe(1199541600)
      })

      test("with time update more than 90 minutes deviated from schedule", async () => {
        fakeGtfs.setTripUpdates([
          {
            trip: {
              tripId: "STBA",
              startDate: "20080104",
              scheduleRelationship:
                GtfsRt.TripDescriptor.ScheduleRelationship.SCHEDULED,
            },
            stopTimeUpdate: [
              {
                stopId: "STAGECOACH",
                arrival: {
                  time: 1199460700,
                },
              },
            ],
          },
        ])

        const trips = await getTripSchedule()
        expect(
          trips.some(
            (trip) =>
              trip.tripId === "testfeed:STBA" &&
              trip.arrivalTime === 1199460700,
          ),
        ).toBe(false)
        expect(
          trips.some(
            (trip) => trip.tripId === "testfeed:STBA" && trip.isRealtime,
          ),
        ).toBe(false)
      })

      test.each(["arrival", "departure"])(
        "with %s time update",
        async (arrivalOrDeparture: string) => {
          fakeGtfs.setTripUpdates([
            {
              trip: {
                tripId: "STBA",
                startDate: "20080104",
                scheduleRelationship:
                  GtfsRt.TripDescriptor.ScheduleRelationship.SCHEDULED,
              },
              stopTimeUpdate: [
                {
                  stopId: "STAGECOACH",
                  [arrivalOrDeparture]: {
                    time: 1199455230,
                  },
                },
              ],
            },
          ])

          const trips = await getTripSchedule()
          const trip = trips.find((trip) => trip.tripId === "testfeed:STBA")

          expect(trip).toBeDefined()
          expect(trip!.arrivalTime).toBe(1199455230)
          expect(trip!.departureTime).toBe(1199455230)
          expect(trip!.isRealtime).toBe(true)
        },
      )

      test.each(["arrival", "departure"])(
        "with %s delay",
        async (arrivalOrDeparture: string) => {
          fakeGtfs.setTripUpdates([
            {
              trip: {
                tripId: "STBA",
                startDate: "20080104",
                scheduleRelationship:
                  GtfsRt.TripDescriptor.ScheduleRelationship.SCHEDULED,
              },
              stopTimeUpdate: [
                {
                  stopId: "STAGECOACH",
                  [arrivalOrDeparture]: {
                    delay: 30,
                  },
                },
              ],
            },
          ])

          const trips = await getTripSchedule()
          const trip = trips.find((trip) => trip.tripId === "testfeed:STBA")

          expect(trip).toBeDefined()
          expect(trip!.arrivalTime).toBe(1199455230)
          expect(trip!.departureTime).toBe(1199455230)
          expect(trip!.isRealtime).toBe(true)
        },
      )

      test("with cancelled trip", async () => {
        fakeGtfs.setTripUpdates([
          {
            trip: {
              tripId: "AAMV1",
              startDate: "20080105",
              scheduleRelationship:
                GtfsRt.TripDescriptor.ScheduleRelationship.CANCELED,
            },
          },
        ])

        const trips = await getTripSchedule()
        expect(trips.some((trip) => trip.tripId === "testfeed:AAMV1")).toBe(
          false,
        )
      })

      test("with update to overnight trip (crossing midnight)", async () => {
        dateSpy.mockImplementation(() =>
          new Date("2008-01-05T08:25:00.000Z").getTime(),
        )

        fakeGtfs.setTripUpdates([
          {
            trip: {
              tripId: "STBA_OVERNIGHT",
              scheduleRelationship:
                GtfsRt.TripDescriptor.ScheduleRelationship.SCHEDULED,
            },
            stopTimeUpdate: [
              {
                stopId: "STAGECOACH",
                arrival: {
                  time: 1199521830,
                },
              },
            ],
          },
        ])

        const trips = await getTripSchedule()
        const overnightTrips = trips.filter(
          (trip) => trip.tripId === "testfeed:STBA_OVERNIGHT",
        )

        expect(overnightTrips).toHaveLength(2)

        expect(overnightTrips[0].arrivalTime).toBe(1199521830)
        expect(overnightTrips[0].departureTime).toBe(1199521830)
        expect(overnightTrips[0].isRealtime).toBe(true)

        expect(overnightTrips[1].arrivalTime).toBe(1199608200)
        expect(overnightTrips[1].departureTime).toBe(1199608200)
        expect(overnightTrips[1].isRealtime).toBe(false)
      })

      test("with skipped stop by stop_id", async () => {
        fakeGtfs.setTripUpdates([
          {
            trip: {
              tripId: "AAMV2",
              startDate: "20080105",
              scheduleRelationship:
                GtfsRt.TripDescriptor.ScheduleRelationship.SCHEDULED,
            },
            stopTimeUpdate: [
              {
                stopId: "BEATTY_AIRPORT",
                scheduleRelationship:
                  GtfsRt.TripUpdate.StopTimeUpdate.ScheduleRelationship.SKIPPED,
              },
            ],
          },
          {
            trip: {
              tripId: "AAMV3",
              startDate: "20080105",
              scheduleRelationship:
                GtfsRt.TripDescriptor.ScheduleRelationship.SCHEDULED,
            },
            stopTimeUpdate: [
              {
                stopId: "SOME_OTHER_STOP",
                scheduleRelationship:
                  GtfsRt.TripUpdate.StopTimeUpdate.ScheduleRelationship.SKIPPED,
              },
            ],
          },
        ])

        const trips = await getTripSchedule()
        expect(trips.some((trip) => trip.tripId === "testfeed:AAMV2")).toBe(
          false,
        )

        expect(trips.some((trip) => trip.tripId === "testfeed:AAMV3")).toBe(
          true,
        )
      })

      test("with skipped stop by stop_sequence", async () => {
        fakeGtfs.setTripUpdates([
          {
            trip: {
              tripId: "AAMV2",
              startDate: "20080105",
              scheduleRelationship:
                GtfsRt.TripDescriptor.ScheduleRelationship.SCHEDULED,
            },
            stopTimeUpdate: [
              {
                stopSequence: 2, // stop_id: BEATTY_AIRPORT
                scheduleRelationship:
                  GtfsRt.TripUpdate.StopTimeUpdate.ScheduleRelationship.SKIPPED,
              },
            ],
          },
          {
            trip: {
              tripId: "AAMV3",
              startDate: "20080105",
              scheduleRelationship:
                GtfsRt.TripDescriptor.ScheduleRelationship.SCHEDULED,
            },
            stopTimeUpdate: [
              {
                stopSequence: 2, // stop_id: AMV
                scheduleRelationship:
                  GtfsRt.TripUpdate.StopTimeUpdate.ScheduleRelationship.SKIPPED,
              },
            ],
          },
        ])

        const trips = await getTripSchedule()
        expect(trips.some((trip) => trip.tripId === "testfeed:AAMV2")).toBe(
          false,
        )

        expect(trips.some((trip) => trip.tripId === "testfeed:AAMV3")).toBe(
          true,
        )
      })
    })
  })
})
