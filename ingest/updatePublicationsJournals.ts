import { ApolloClient } from 'apollo-client'
import { InMemoryCache } from 'apollo-cache-inmemory'
import { createHttpLink } from 'apollo-link-http'
import fetch from 'node-fetch'
import _ from 'lodash'
import readJournals from './gql/readJournals'
import readPublicationsWoutJournal from './gql/readPublicationsWoutJournal'
import readPublicationsWoutJournalByYear from './gql/readPublicationsWoutJournalByYear'
import updatePubJournal from './gql/updatePubJournal'
import { __EnumValue } from 'graphql'
import dotenv from 'dotenv'
import pMap from 'p-map'
import { randomWait } from './units/randomWait'
const Fuse = require('fuse.js')

import { removeSpaces, normalizeString, normalizeObjectProperties } from './units/normalizer'


dotenv.config({
  path: '../.env'
})

const axios = require('axios');

const elsApiKey = process.env.SCOPUS_API_KEY
const elsCookie = process.env.SCOPUS_API_COOKIE
const hasuraSecret = process.env.HASURA_SECRET
const graphQlEndPoint = process.env.GRAPHQL_END_POINT

// environment variables
process.env.NODE_ENV = 'development';

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


function journalMatchFuzzy (journalTitle, titleKey, journalMap){
  // first normalize the diacritics
  const testJournalMap = _.map(journalMap, (journal) => {
     return normalizeObjectProperties(journal, [titleKey], { removeSpaces: true, skipLower: true })
  })
  // normalize last name checking against as well
  const testTitle = normalizeString(journalTitle, { removeSpaces: true, skipLower: true })
  const lastFuzzy = new Fuse(journalMap, {
    caseSensitive: false,
    shouldSort: true,
    includeScore: false,
    keys: [titleKey],
    findAllMatches: true,
    threshold: 0.001,
  });

  const journalResults = lastFuzzy.search(testTitle)
  const reducedResults = _.map(journalResults, (result) => {
    return result['item'] ? result['item'] : result
  })
  return reducedResults
}

async function getPublications (startYear?) {
  if (startYear) {
    const queryResult = await client.query(readPublicationsWoutJournalByYear(startYear))
    return queryResult.data.publications
  } else {
    const queryResult = await client.query(readPublicationsWoutJournal())
    return queryResult.data.publications
  }
}

async function getJournals () {
  const queryResult = await client.query(readJournals())
  return queryResult.data.journals
}

async function main (): Promise<void> {

  // default to startYear undefined to check all missing journals
  let startYear
  // startYear = 2020
  const publications = await getPublications(startYear)
  const journals = await getJournals()

  // first normalize the diacritics
  const journalMap = _.map(journals, (journal) => {
    return normalizeObjectProperties(journal, ['title'], { removeSpaces: true, skipLower: true })
  })

  const multipleMatches = []
  const zeroMatches = []
  const singleMatches = []

  const subset = _.chunk(publications, 1)

  let pubCounter = 0
  await pMap(publications, async (publication) => {
    pubCounter += 1
    // normalize last name checking against as well
    console.log(`${pubCounter} - Checking publication id: ${publication['id']}`)
    let matchedJournal = undefined
    if (publication['journal_title']) {
      const testTitle = normalizeString(publication['journal_title'], { removeSpaces: true, skipLower: true })
      const matchedJournals = journalMatchFuzzy(testTitle, 'title', journalMap)
      let matchedInfo = {
        'doi': publication['doi'],
        'Article': publication['title'],
        'Journal_Text': publication['journal_title'],
        'Matches': matchedJournals
      }
      if (matchedJournals.length > 1) {
        _.each(matchedJournals, (matched) => {
          if (_.lowerCase(matched['title']) === _.lowerCase(testTitle)) {
            matchedInfo['Matches'] = [matched]
          }
        })
        if (matchedInfo['Matches'] && matchedInfo['Matches'].length === 1) {
          singleMatches.push(matchedInfo)
        } else {
          multipleMatches.push(matchedInfo)
        }
      } else if (matchedJournals.length <= 0) {
        zeroMatches.push(matchedInfo)
      } else {
        singleMatches.push(matchedInfo)
      }
    }
  }, {concurrency: 60})

  console.log(`Multiple Matches: ${JSON.stringify(multipleMatches, null, 2)}`)
  console.log(`Multiple Matches Count: ${multipleMatches.length}`)
  console.log(`No Matches Count: ${zeroMatches.length}`)
  console.log(`Single Matches Count: ${singleMatches.length}`)

  //insert single matches
  let loopCounter = 0
  await pMap(singleMatches, async (matched) => {
    loopCounter += 1
    await randomWait(loopCounter)
    console.log(`Updating journal of pub ${loopCounter} ${matched['Article']}`)
    const resultUpdatePubJournal = await client.mutate(updatePubJournal(matched['doi'], matched['Matches'][0]['id']))
  }, {concurrency: 10})
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
main()
