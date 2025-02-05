import _ from 'lodash'
import { ApolloClient, MutationOptions } from 'apollo-client'
import { InMemoryCache } from 'apollo-cache-inmemory'
import { createHttpLink } from 'apollo-link-http'
import fetch from 'node-fetch'
import pMap from 'p-map'
import moment from 'moment'
import dotenv from 'dotenv'
import { randomWait, wait } from './units/randomWait'
import { Harvester, HarvestOperation } from './modules/harvester'
import { WosDataSource } from './modules/wosDataSource'
import { getAllNormedPersonsByYear } from '../ingest/modules/queryNormalizedPeople'
import NormedPerson from './modules/normedPerson'
import { getDateObject } from './units/dateRange'

import DataSourceConfig from '../ingest/modules/dataSourceConfig'

dotenv.config({
  path: '../.env'
})

const axios = require('axios');

// environment variables
process.env.NODE_ENV = 'development';

// uncomment below line to test this code against staging environment
// process.env.NODE_ENV = 'staging';

// config variables
const config = require('../config/config.js');

const hasuraSecret = process.env.HASURA_SECRET
const graphQlEndPoint = process.env.GRAPHQL_END_POINT

const client = new ApolloClient({
  link: createHttpLink({
    uri: graphQlEndPoint,
    headers: {
      'x-hasura-admin-secret': hasuraSecret
    },
    fetch: fetch as any
  }),
  cache: new InMemoryCache()
})

async function main (): Promise<void> {

  const dsConfig: DataSourceConfig = {
    baseUrl: process.env.WOS_BASE_URL,
    queryUrl: process.env.WOS_QUERY_URL,
    userName: process.env.WOS_USERNAME,
    password: process.env.WOS_PASSWORD,
    sourceName: process.env.WOS_SOURCE_NAME,
    pageSize: process.env.WOS_PAGE_SIZE,  // page size must be a string for the request to work
    requestInterval: Number.parseInt(process.env.WOS_REQUEST_INTERVAL)
  }

  const ds: WosDataSource = new WosDataSource(dsConfig)
  const harvester: Harvester = new Harvester(ds)
  
  const years = [ 2020 ]
  let succeededPapers = []
  let failedPapers = []
  let succeededAuthors = []
  let failedAuthors = []
  await pMap(years, async (year) => {
    const normedPersons: NormedPerson[] = await getAllNormedPersonsByYear(year, client)

    const resultsDir = `../data/${dsConfig.sourceName}_${year}_${moment().format('YYYYMMDDHHmmss')}/`

    // console.log(`Person with harvest errors for ${year} are: ${JSON.stringify(personWithHarvestErrors,null,2)}`)
    // console.log(`Normed persons for ${year} are: ${JSON.stringify(normedPersons,null,2)}`)
    // console.log(`Normed persons for ${year} are: ${JSON.stringify(normedPersons.length,null,2)}`)


    let personCounter = 0

    const subset = _.chunk(normedPersons, 1)
    // await pMap(personWithHarvestErrors, async (person) => {
    await pMap(subset, async (persons) => {
      try {
        personCounter += 1
        const person = persons[0]
        console.log(`Getting papers for ${person.familyName}, ${person.givenName} persons`)
        // run for each name plus name variance, put name variance second in case undefined
        // let searchNames = _.concat([{given_name: person.firstName, family_name: person.lastName }], person.nameVariances)
        // if (person.id === 2052) {
        await wait(dsConfig.requestInterval)
        await harvester.harvestToCsv(resultsDir, persons, HarvestOperation.QUERY_BY_AUTHOR_NAME, getDateObject(`${year}-01-01`), getDateObject(`${year}-12-31`), `${person.familyName}_${person.givenName}`)
          // await pMap(searchNames, async (searchName) => {
        await wait(1500)
          
         // }, { concurrency: 1})
        succeededAuthors = _.concat(succeededAuthors, persons)
        // } else {
        //   console.log(`Skipping author ${person.familyName}, ${person.givenName} persons`)
        // }
      } catch (error) {
        const errorMessage = `Error on get Web Of Science papers for authors: ${JSON.stringify(persons, null, 2)}: ${error}`
        failedPapers.push(errorMessage)
        _.concat(failedAuthors, persons)
        console.log(errorMessage)
      }
    }, {concurrency: 1})
  }, { concurrency: 1 })
}

main();
