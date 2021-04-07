import axios from 'axios'
import _ from 'lodash'
import { ApolloClient, MutationOptions } from 'apollo-client'
import { InMemoryCache } from 'apollo-cache-inmemory'
import { createHttpLink } from 'apollo-link-http'
import fetch from 'node-fetch'
import pEachSeries from 'p-each-series'
import readUsers from '../client/src/gql/readPersons'
import insertPublication from './gql/insertPublication'
import insertPersonPublication from './gql/insertPersonPublication'
import insertPubAuthor from './gql/insertPubAuthor'
import { command as loadCsv } from './units/loadCsv'
import { responsePathAsArray } from 'graphql'
import Cite from 'citation-js'
import pMap from 'p-map'
import { command as nameParser } from './units/nameParser'
import humanparser from 'humanparser'
import { randomWait } from './units/randomWait'
import { command as writeCsv } from './units/writeCsv'
import moment from 'moment'

import dotenv from 'dotenv'
import readPublicationsByDoi from './gql/readPublicationsByDoi'
import readPersonPublicationsByDoi from './gql/readPersonPublicationsByDoi'
import { getAllSimplifiedPersons } from './modules/queryNormalizedPeople'
import { CalculateConfidence } from './modules/calculateConfidence'
// import insertReview from '../client/src/gql/insertReview'

dotenv.config({
  path: '../.env'
})

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

// var publicationId= undefined;

// async function getDoiPaperData (doi) {
//   const result = await axios({
//       method: 'get',
//       url: `http://dx.doi.org/${doi}`,

//       headers: {
//         //get result in csl-json format
//         'Accept': 'application/citeproc+json'
//       }
//   })

//   return result.data;
// }

function getPublicationYear (csl) : Number {
  // look for both online and print dates, and make newer date win if different
  // put in array sorted by date
  let years = []
  years.push(_.get(csl, 'journal-issue.published-print.date-parts[0][0]', null))
  years.push(_.get(csl, 'journal-issue.published-online.date-parts[0][0]', null))
  years.push(_.get(csl, 'issued.date-parts[0][0]', null))
  years.push(_.get(csl, 'published-print.date-parts[0][0]', null))
  years.push(_.get(csl, 'published-online.date-parts[0][0]', null))

  years = _.sortBy(years, (year) => { return year === null ?  0 : Number.parseInt(year) }).reverse()
  if (years.length > 0 && years[0] > 0) {
    // return the most recent year
    return years[0]
  } else {
    const item = new Cite(csl)
    const citation = item.format('citation')
    let year = null
    // last item in string is the year after the last comma
    const items = _.split(citation, ',')

    if (items.length > 0){
      year = items[items.length - 1]
      // get rid of any parentheses
      year = _.replace(year, ')', '')
      year = _.replace(year, '(', '')
      // remove any whitespace
      return Number.parseInt(_.trim(year))
    } else {
      throw(`Unable to determine publication year from csl: ${JSON.stringify(csl, null, 2)}`)
    }
  }

}

async function insertPublicationAndAuthors (title, doi, csl, authors, sourceName, sourceMetadata, minPublicationYear?) {
  //console.log(`trying to insert pub: ${JSON.stringify(title,null,2)}, ${JSON.stringify(doi,null,2)}`)
  try  {
    const publicationYear = getPublicationYear (csl)
    if (minPublicationYear != undefined && publicationYear < minPublicationYear) {
      console.log(`Skipping adding publication from year: ${publicationYear}`)
      return
    }

    const publication = {
      title: title,
      doi: doi,
      year: publicationYear,
      csl: csl,  // put these in as JSONB
      source_name: sourceName,
      source_metadata: sourceMetadata, // put these in as JSONB,
      csl_string: JSON.stringify(csl)
    }
    const mutatePubResult = await client.mutate(
      //for now convert csl json object to a string when storing in DB
      insertPublication ([publication])
    )
    //console.log(`Insert mutate pub result ${JSON.stringify(mutatePubResult.data,null,2)}`)
    const publicationId = 0+parseInt(`${ mutatePubResult.data.insert_publications.returning[0].id }`);
    // console.log(`Added publication with id: ${ publicationId }`)

    //console.log(`Pub Id: ${publicationId} Adding ${authorMap.firstAuthors.length + authorMap.otherAuthors.length} total authors`)
    const insertAuthors = _.map(authors, (author) => {
      return {
        publication_id: publicationId,
        family_name: author.family,
        given_name: author.given,
        position: author.position
      }
    })

    try {
      //console.log(`publication id: ${ publicationId } inserting first author: ${ JSON.stringify(firstAuthor) }`)
      const mutateFirstAuthorResult = await client.mutate(
        insertPubAuthor(insertAuthors)
      )
    } catch (error) {
      console.log(`Error on insert of Doi: ${doi} insert authors: ${JSON.stringify(insertAuthors,null,2)}`)
      console.log(error)
      throw error
    }
    return publicationId
  } catch (error){
    console.log(`Error on insert of Doi: ${doi} insert publication, csl: ${JSON.stringify}`)
    console.log(error)
    throw error
  }
}

async function getPapersByDoi (csvPath: string) {
  console.log(`Loading Papers from path: ${csvPath}`)
  // ingest list of DOI's from CSV and relevant center author name
  try {
    const authorPapers: any = await loadCsv({
     path: csvPath
    })

    //console.log(`Getting Keys for author papers`)

    //normalize column names to all lowercase
    const authorLowerPapers = _.mapValues(authorPapers, function (paper) {
      return _.mapKeys(paper, function (value, key) {
        return key.toLowerCase()
      })
    })

    console.log(`After lowercase ${_.keys(authorLowerPapers[0])}`)

    const papersByDoi = _.groupBy(authorLowerPapers, function(paper) {
      //strip off 'doi:' if present
      //console.log('in loop')
      return _.replace(paper['doi'], 'doi:', '')
    })
    //console.log('Finished load')
    return papersByDoi
  } catch (error){
    console.log(`Error on paper load for path ${csvPath}, error: ${error}`)
    return undefined
  }
}

async function getConfirmedAuthorsByDoi (papersByDoi, csvColumn :string) {
  const confirmedAuthorsByDoi = _.mapValues(papersByDoi, function (papers) {
    //console.log(`Parsing names from papers ${JSON.stringify(papers,null,2)}`)
    return _.mapValues(papers, function (paper) {
      const unparsedName = paper[csvColumn]
      //console.log(`Parsing name: ${unparsedName}`)
      if (unparsedName) {
        const parsedName =  humanparser.parseName(unparsedName)
        //console.log(`Parsed Name is: ${JSON.stringify(parsedName,null,2)}`)
        return parsedName 
      } else {
        return undefined
      }
    })
  })
  return confirmedAuthorsByDoi
}

function getConfirmedAuthorsByDOIAuthorList(papersByDoi, csvColumn :string) {
  const confirmedAuthorsByDoiAuthorList = _.mapValues(papersByDoi, function (papers) {
    //console.log(`Parsing names from papers ${JSON.stringify(papers,null,2)}`)
    return _.mapValues(papers, function (paper) {
      const unparsedList = paper[csvColumn]
      return createAuthorCSLFromString(unparsedList)
    })
  })
  return confirmedAuthorsByDoiAuthorList
} 

function createAuthorCSLFromString (authors) {
  const parsedAuthors = _.split(authors, ';')
  let authorPosition = 0
  let cslAuthors = []
  _.each(parsedAuthors, (parsedAuthor) => {
    const authorNames = _.split(parsedAuthor, ',')
    authorPosition += 1
    const cslAuthor = {
      family: authorNames[0],
      given: authorNames[1],
      position: authorPosition
    }
    cslAuthors.push(cslAuthor)
  })
  return cslAuthors
}

async function getCSLAuthors(paperCsl){

  const authMap = {
    firstAuthors : [],
    otherAuthors : []
  }

  let authorCount = 0
  //console.log(`Before author loop paper csl: ${JSON.stringify(paperCsl,null,2)}`)
  _.each(paperCsl.author, async (author) => {
    // skip if family_name undefined
    if (author.family != undefined){
      //console.log(`Adding author ${JSON.stringify(author,null,2)}`)
      authorCount += 1

      //if given name empty change to empty string instead of null, so that insert completes
      if (author.given === undefined) author.given = ''

      if (_.lowerCase(author.sequence) === 'first' ) {
        //console.log(`found first author ${ JSON.stringify(author) }`)
        authMap.firstAuthors.push(author)
      } else {
        //console.log(`found add\'l author ${ JSON.stringify(author) }`)
        authMap.otherAuthors.push(author)
      }
    }
  })

  //add author positions
  authMap.firstAuthors = _.forEach(authMap.firstAuthors, function (author, index){
    author.position = index + 1
  })

  authMap.otherAuthors = _.forEach(authMap.otherAuthors, function (author, index){
    author.position = index + 1 + authMap.firstAuthors.length
  })

  //concat author arrays together
  const authors = _.concat(authMap.firstAuthors, authMap.otherAuthors)

  //console.log(`Author Map found: ${JSON.stringify(authMap,null,2)}`)
  return authors
}

interface MatchedPerson {
  person: any; // TODO: What is this creature?
  confidence: number;
}
// person map assumed to be a map of simplename to simpleperson object
// author map assumed to be doi mapped to two arrays: first authors and other authors
// returns a map of person ids to the person object and confidence value for any persons that matched coauthor attributes
// example: {1: {person: simplepersonObject, confidence: 0.5}, 51: {person: simplepersonObject, confidence: 0.8}}
async function matchPeopleToPaperAuthors(publicationCSL, simplifiedPersons, personMap, authors, confirmedAuthors, sourceName) : Promise<Map<number,MatchedPerson>> {

  const calculateConfidence: CalculateConfidence = new CalculateConfidence()
  //match to last name
  //match to first initial (increase confidence)
  let matchedPersonMap = new Map()

  const confidenceTypesByRank = await calculateConfidence.getConfidenceTypesByRank()
   await pMap(simplifiedPersons, async (person) => {
    
     //console.log(`Testing Author for match: ${author.family}, ${author.given}`)

      const passedConfidenceTests = await calculateConfidence.performAuthorConfidenceTests (person, publicationCSL, confirmedAuthors, confidenceTypesByRank)
      // console.log(`Passed confidence tests: ${JSON.stringify(passedConfidenceTests, null, 2)}`)
      // returns a new map of rank -> confidenceTestName -> calculatedValue
      const passedConfidenceTestsWithConf = await calculateConfidence.calculateAuthorConfidence(passedConfidenceTests)
      // calculate overall total and write the confidence set and comments to the DB
      let confidenceTotal = 0.0
      _.mapValues(passedConfidenceTestsWithConf, (confidenceTests, rank) => {
        _.mapValues(confidenceTests, (confidenceTest) => {
          confidenceTotal += confidenceTest['confidenceValue']
        })
      })
      // set ceiling to 99%
      if (confidenceTotal >= 1.0) confidenceTotal = 0.99
      // have to do some weird conversion stuff to keep the decimals correct
      confidenceTotal = Number.parseFloat(confidenceTotal.toFixed(3))
      // console.log(`passed confidence tests are: ${JSON.stringify(passedConfidenceTestsWithConf, null, 2)}`)
      //check if persons last name in author list, if so mark a match
          //add person to map with confidence value > 0
        if (confidenceTotal > 0) {
          // console.log(`Match found for Author: ${author.family}, ${author.given}`)
          let matchedPerson: MatchedPerson = { 'person': person, 'confidence': confidenceTotal }
          matchedPersonMap[person['id']] = matchedPerson
          //console.log(`After add matched persons map is: ${JSON.stringify(matchedPersonMap,null,2)}`)
        }
   }, { concurrency: 1 })

   //console.log(`After tests matchedPersonMap is: ${JSON.stringify(matchedPersonMap,null,2)}`)
  return matchedPersonMap
}

async function isPublicationAlreadyInDB (doi, sourceName) : Promise<boolean> {
  const queryResult = await client.query(readPublicationsByDoi(doi))
  let foundPub = false
  _.each(queryResult.data.publications, (publication) => {
    if (publication.doi === doi && _.toLower(publication.source_name) === _.toLower(sourceName)) {
      foundPub = true
    }
  })
  return foundPub
}

async function getPersonPublications (doi: string, personId: number) {
  const queryResult = await client.query(readPersonPublicationsByDoi(doi, personId))
  return queryResult.data.persons_publications_metadata
}

interface DoiStatus {
  addedDOIs: Array<string>;
  skippedDOIs: Array<string>;
  failedDOIs: Array<string>;
  errorMessages: Array<string>;
}

function lessThanMinPublicationYear(paper, doi, minPublicationYear) {
  // Check publication year to see if we should just ignore it
  let pubYearKey = undefined
  if (paper['publication_year']) {
    pubYearKey = 'publication_year'
  } else if (paper['pubYear']) {
    pubYearKey = 'pubYear'
  } else if (paper['pubyear']) {
    pubYearKey = 'pubyear'
  }

  if (minPublicationYear != undefined && pubYearKey != undefined && paper[pubYearKey]){
    const sourcePubYear = (paper[pubYearKey] === '' ? undefined : Number.parseInt(paper[pubYearKey]))
    if (sourcePubYear != undefined) {
      console.log(`Source pub year found for error publication: ${sourcePubYear} for doi: ${(doi ? doi: 'undefined')}`)
      return (sourcePubYear < minPublicationYear)
    }
  }
  return false    
}

async function loadConfirmedAuthorPapersFromCSV(path) {
  try {
    const papersByDoi = await getPapersByDoi(path)
    return papersByDoi
  } catch (error){
    console.log(`Error on load confirmed authors: ${error}`)
    return {}
  }
}

async function loadConfirmedPapersByDoi(pathsByYear) {
  let confirmedPapersByDoi = new Map()
  await pMap(_.keys(pathsByYear), async (year) => {
    console.log(`Loading ${year} Confirmed Authors`)
    //load data
    await pMap(pathsByYear[year], async (path: string) => {
      confirmedPapersByDoi = _.merge(confirmedPapersByDoi, await getPapersByDoi(path))
    }, { concurrency: 1})
  }, { concurrency: 1 })
  return confirmedPapersByDoi
}

//returns a map of three arrays: 'addedDOIs','failedDOIs', 'errorMessages'
async function loadPersonPapersFromCSV (personMap, path, minPublicationYear?) : Promise<DoiStatus> {
  let count = 0
  let doiStatus: DoiStatus = {
    addedDOIs: [],
    skippedDOIs: [],
    failedDOIs: [],
    errorMessages: []
  }
  try {
    const calculateConfidence: CalculateConfidence = new CalculateConfidence()
    // get the set of persons to test
    const testAuthors = await calculateConfidence.getAllSimplifiedPersons()
    // const testAuthors = []
    //create map of last name to array of related persons with same last name
    const testPersonMap = _.transform(testAuthors, function (result, value) {
      _.each(value.names, (name) => {
        (result[name['lastName']] || (result[name['lastName']] = [])).push(value)
      })
    }, {})
    const papersByDoi = await getPapersByDoi(path)
    const dois = _.keys(papersByDoi)
    count = dois.length
    console.log(`Papers by DOI Count: ${JSON.stringify(dois.length,null,2)}`)

    //check if confirmed column exists first, if not ignore this step
    let confirmedAuthorsByDoi = {}
    let confirmedAuthorsByDoiAuthorList = {}
    let bibTexByDoi = {}

    // get confirmed author lists to papers
    const confirmedPathsByYear = await getIngestFilePathsByYear("../config/ingestConfidenceReviewFilePaths.json")
    const confirmedPapersByDoi: {} = await loadConfirmedPapersByDoi(confirmedPathsByYear)

    const confirmedAuthorColumn = 'nd author (last, first)'
    const confirmedAuthorListColumn = 'author(s)'
    const confirmedDois = _.keys(confirmedPapersByDoi)
   
    if (confirmedPapersByDoi && confirmedDois.length > 0){
      //get map of DOI's to an array of confirmed authors from the load table
      confirmedAuthorsByDoi = await getConfirmedAuthorsByDoi(confirmedPapersByDoi, confirmedAuthorColumn)
      confirmedAuthorsByDoiAuthorList = getConfirmedAuthorsByDOIAuthorList(confirmedPapersByDoi, confirmedAuthorListColumn)
      bibTexByDoi = _.mapValues(confirmedPapersByDoi, (papers) => {
        return _.mapValues(papers, (paper) => {
          return paper['bibtex']
        })
      })
      console.log(`Confirmed Authors By Doi are: ${JSON.stringify(confirmedAuthorsByDoi,null,2)}`)
      console.log(`Confirmed Authors By Doi author list are: ${JSON.stringify(confirmedAuthorsByDoiAuthorList,null,2)}`)
      console.log(`Confirmed Authors BibText By Doi is: ${JSON.stringify(bibTexByDoi,null,2)}`)
    }

    //initalize the doi query and citation engine
    Cite.async()

    let loopCounter = 0


    // let newPersonPublicationsByDoi = {}

    let processedCount = 0
    
    let failedRecords = {}

    await pMap(_.keys(papersByDoi), async (doi) => {
      try {
        processedCount += 1
        loopCounter += 1

        if (processedCount % 100 === 0){
          console.log(`Processed ${processedCount} papers...`)
          console.log(`Error Messages: ${JSON.stringify(doiStatus.errorMessages,null,2)}`)
          console.log(`Current DOIs Failed: ${JSON.stringify(doiStatus.failedDOIs.length,null,2)}`)
          console.log(`Current Skipped DOIs: ${JSON.stringify(doiStatus.skippedDOIs.length,null,2)}`)
          console.log(`Current Added DOIs: ${JSON.stringify(doiStatus.addedDOIs.length,null,2)}`)
        }
        //have each wait a pseudo-random amount of time between 1-5 seconds

        await randomWait(loopCounter)
        let cslRecords = undefined
        let csl = undefined
        try {
        
          //get CSL (citation style language) record by doi from dx.dio.org
          cslRecords = await Cite.inputAsync(doi)
          //console.log(`For DOI: ${doi}, Found CSL: ${JSON.stringify(cslRecords,null,2)}`)
          csl = cslRecords[0]
        } catch (error) {
          if (bibTexByDoi[doi] && _.keys(bibTexByDoi[doi]).length > 0){
            console.log(`Trying to get csl from bibtex for confirmed doi: ${doi}...`)
            // manually construct csl from metadata in confirmed list
            const bibTex = bibTexByDoi[doi][_.keys(bibTexByDoi[doi])[0]]
            if (bibTex) {
              // console.log(`Trying to get csl from bibtex for confirmed doi: ${doi}, for bibtex found...`)
              cslRecords = await Cite.inputAsync(bibTex)
              csl = cslRecords[0]
              // console.log(`CSL constructed: ${JSON.stringify(csl, null, 2)}`)
            }
          } else {
            throw (error)
          }
        }
        
        //retrieve the authors from the record and put in a map, returned above in array, but really just one element
        let authors = await getCSLAuthors(csl)

        // default to the confirmed author list if no author list in the csl record
        // console.log(`Before check authors are: ${JSON.stringify(authors, null, 2)} for doi: ${doi}`)
        if (!authors || authors.length <= 0 && confirmedAuthorsByDoiAuthorList[doi] && _.keys(confirmedAuthorsByDoiAuthorList[doi]).length > 0) {
          authors = confirmedAuthorsByDoiAuthorList[doi][_.keys(confirmedAuthorsByDoiAuthorList[doi])[0]]
          csl.author = authors
        }
        // console.log(`Authors found: ${JSON.stringify(authors,null,2)}`)

        //for now default source is crossref
        let sourceName = 'CrossRef'
        let sourceMetadata= csl
        let errorMessage = ''

        // if at least one author, add the paper, and related personpub objects
        if((csl['type'] === 'article-journal' || csl['type'] === 'paper-conference' || csl['type'] === 'chapter' || csl['type'] === 'book') && csl.title) {
          //push in csl record to jsonb blob
          //console.log(`Trying to insert for for DOI:${doi}, Title: ${csl.title}`)

          //check for SCOPUS
          //console.log(`Checking paper if from scopus: ${JSON.stringify(papersByDoi[doi],null,2)}`)
          //there may be more than one author match with same paper, and just grab first one
          if (papersByDoi[doi].length >= 1 && papersByDoi[doi][0]['scopus_record']){
            sourceName = 'Scopus'
            sourceMetadata = papersByDoi[doi][0]['scopus_record']
            if (_.isString(sourceMetadata)) sourceMetadata = JSON.parse(sourceMetadata)
            // console.log(`Scopus Source metadata is: ${JSON.stringify(sourceMetadata,null,2)}`)
          } else if (papersByDoi[doi].length >= 1 && papersByDoi[doi][0]['pubmed_record']){
            sourceName = 'PubMed'
            sourceMetadata = papersByDoi[doi][0]['pubmed_record']
            if (_.isString(sourceMetadata)) sourceMetadata = JSON.parse(sourceMetadata)
            // console.log(`Pubmed Source metadata found`)//is: ${JSON.stringify(sourceMetadata,null,2)}`)
          } else if (papersByDoi[doi].length >= 1 && papersByDoi[doi][0]['wos_record']){
            sourceName = 'WebOfScience'
            sourceMetadata = papersByDoi[doi][0]['wos_record']
            if (_.isString(sourceMetadata)) sourceMetadata = JSON.parse(sourceMetadata)
            // console.log(`WebOfScience Source metadata found`)//is: ${JSON.stringify(sourceMetadata,null,2)}`)
          }
          //match paper authors to people
          //console.log(`Testing for Author Matches for DOI: ${doi}`)
          const matchedPersons = await matchPeopleToPaperAuthors(csl, testAuthors, personMap, authors, confirmedAuthorsByDoi[doi], sourceName)
          //console.log(`Person to Paper Matches: ${JSON.stringify(matchedPersons,null,2)}`)

          if (_.keys(matchedPersons).length > 0){
            const pubFound = await isPublicationAlreadyInDB(doi, sourceName)
            const publicationYear = getPublicationYear (csl)
            if (minPublicationYear != undefined && publicationYear < minPublicationYear) {
              console.log(`Skipping add Publication #${processedCount} of total ${count} DOI: ${doi} from source: ${sourceName} from year: ${publicationYear}`)
              doiStatus.skippedDOIs.push(doi)
            } else if (!pubFound) {
              // console.log(`Inserting Publication #${processedCount} of total ${count} DOI: ${doi} from source: ${sourceName}`)
              const publicationId = await insertPublicationAndAuthors(csl.title, doi, csl, authors, sourceName, sourceMetadata)
              // console.log('Finished Running Insert and starting next thread')
              //console.log(`Inserted pub: ${JSON.stringify(publicationId,null,2)}`)

              //console.log(`Publication Id: ${publicationId} Matched Persons count: ${_.keys(matchedPersons).length}`)
              // now insert a person publication record for each matched Person
              let loopCounter2 = 0
              await pMap(_.keys(matchedPersons), async function (personId){
                try {
                  const person = matchedPersons[personId]
                  loopCounter2 += 1
                  //have each wait a pseudo-random amount of time between 1-5 seconds
                  await randomWait(loopCounter2)
                  const mutateResult = await client.mutate(
                    insertPersonPublication(personId, publicationId, person['confidence'])
                  )

                  const newPersonPubId = await mutateResult.data.insert_persons_publications.returning[0]['id']
                  // if (!newPersonPublicationsByDoi[doi]) {
                  //   newPersonPublicationsByDoi[doi] = []
                  // }
                  // const obj = {
                  //   id: newPersonPubId,
                  //   person_id: personId
                  // }
                  // // console.log(`Capturing added person pub: ${JSON.stringify(obj, null, 2)}`)
                  // newPersonPublicationsByDoi[doi].push(obj)

                //console.log(`added person publication id: ${ mutateResult.data.insert_persons_publications.returning[0].id }`)
                } catch (error) {
                  const errorMessage = `Error on add person id ${JSON.stringify(personId,null,2)} to publication id: ${publicationId}`
                  if (!failedRecords[sourceName]) failedRecords[sourceName] = []
                  _.each(papersByDoi[doi], (paper) => {
                    if (lessThanMinPublicationYear(paper, doi, minPublicationYear)) {
                      console.log(`Skipping add Publication #${processedCount} of total ${count} DOI: ${(doi ? doi: 'undefined')} from source: ${sourceName}`)
                      doiStatus.skippedDOIs.push(doi)
                    } else {
                      doiStatus.failedDOIs.push(doi)
                      console.log(errorMessage)
                      doiStatus.errorMessages.push(errorMessage)
                      paper = _.set(paper, 'error', errorMessage)
                      failedRecords[sourceName].push(paper)
                    }
                  }) 
                }
              }, { concurrency: 1 })
              //if we make it this far succeeded
              doiStatus.addedDOIs.push(doi)
              // console.log(`Error Messages: ${JSON.stringify(doiStatus.errorMessages,null,2)}`)
              // console.log(`DOIs Failed: ${JSON.stringify(doiStatus.failedDOIs.length,null,2)}`)
              // console.log(`Skipped DOIs: ${JSON.stringify(doiStatus.skippedDOIs.length,null,2)}`)
            } else {
              doiStatus.skippedDOIs.push(doi)
              console.log(`Skipping doi already in DB #${processedCount} of total ${count}: ${doi} for source: ${sourceName}`)
            }
          } else {
            if (_.keys(matchedPersons).length <= 0){
              errorMessage = `No author match found for ${doi} and not added to DB`
              if (!failedRecords[sourceName]) failedRecords[sourceName] = []
              _.each(papersByDoi[doi], (paper) => {
                if (lessThanMinPublicationYear(paper, doi, minPublicationYear)) {
                  console.log(`Skipping add Publication #${processedCount} of total ${count} DOI: ${(doi ? doi: 'undefined')} from source: ${sourceName}`)
                  doiStatus.skippedDOIs.push(doi)
                } else {
                  doiStatus.failedDOIs.push(doi)
                  console.log(errorMessage)
                  doiStatus.errorMessages.push(errorMessage)
                  paper = _.set(paper, 'error', errorMessage)
                  failedRecords[sourceName].push(paper)
                }
              }) 
            }
          }
        } else {
          errorMessage = `${doi} and not added to DB because not an article or no title defined in DOI csl record, csl is: ${JSON.stringify(csl, null, 2)}`
          console.log(errorMessage)
          doiStatus.errorMessages.push(errorMessage)
          if (!failedRecords[sourceName]) failedRecords[sourceName] = []
          _.each(papersByDoi[doi], (paper) => {
            if (lessThanMinPublicationYear(paper, doi, minPublicationYear)) {
              console.log(`Skipping add Publication #${processedCount} of total ${count} DOI: ${(doi ? doi: 'undefined')} from source: ${sourceName}`)
              doiStatus.skippedDOIs.push(doi)
            } else {
              doiStatus.failedDOIs.push(doi)
              console.log(errorMessage)
              doiStatus.errorMessages.push(errorMessage)
              paper = _.set(paper, 'error', errorMessage)
              failedRecords[sourceName].push(paper)
            }
          }) 
        }
        // console.log(`DOIs Failed: ${JSON.stringify(doiStatus.failedDOIs,null,2)}`)
        // console.log(`Error Messages: ${JSON.stringify(doiStatus.errorMessages,null,2)}`)
      } catch (error) {
        let sourceName = 'CrossRef'
        if (papersByDoi[doi].length >= 1){
          if (papersByDoi[doi][0]['scopus_record']){
            sourceName = 'Scopus'
          } else if (papersByDoi[doi][0]['pubmed_record']){
            sourceName = 'PubMed'
          } else if (papersByDoi[doi][0]['wos_record']){
            sourceName = 'WebOfScience'
          }
        }
        if (!failedRecords[sourceName]) failedRecords[sourceName] = []
        const errorMessage = `Error on add DOI: ${doi} error: ${error}`
        _.each(papersByDoi[doi], (paper) => {
          if (lessThanMinPublicationYear(paper, doi, minPublicationYear)) {
            console.log(`Skipping add Publication #${processedCount} of total ${count} DOI: ${(doi ? doi: 'undefined')} from source: ${sourceName}`)
            doiStatus.skippedDOIs.push(doi)
          } else {
            doiStatus.failedDOIs.push(doi)
            console.log(errorMessage)
            doiStatus.errorMessages.push(errorMessage)
            paper = _.set(paper, 'error', errorMessage)
            failedRecords[sourceName].push(paper)
          }
        }) 
        // console.log(`DOIs Failed: ${JSON.stringify(doiStatus.failedDOIs,null,2)}`)
        // console.log(`Error Messages: ${JSON.stringify(doiStatus.errorMessages,null,2)}`)
      }
    }, { concurrency: 5 })

    // // add any reviews as needed
    // console.log('Synchronizing reviews with pre-existing publications...')
    // // console.log(`New Person pubs by doi: ${JSON.stringify(newPersonPublicationsByDoi, null, 2)}`)
    // let loopCounter3 = 0
    // await pMap(_.keys(newPersonPublicationsByDoi), async (doi) => {
    //   loopCounter3 += 1
    //   //have each wait a pseudo-random amount of time between 1-5 seconds
    //   await randomWait(loopCounter3)
    //   await pMap(newPersonPublicationsByDoi[doi], async (personPub) => {
    //     await synchronizeReviews(doi, personPub['person_id'], personPub['id'])
    //   }, {concurrency: 1})
    // }, {concurrency: 5})


    if (doiStatus.failedDOIs && doiStatus.failedDOIs.length > 0){

      pMap(_.keys(failedRecords), async (sourceName) => {
        const failedCSVFile = `../data/${sourceName}_failed.${moment().format('YYYYMMDDHHmmss')}.csv`

        console.log(`Write failed doi's to csv file: ${failedCSVFile}`)
        // console.log(`Failed records are: ${JSON.stringify(failedRecords[sourceName], null, 2)}`)
        //write data out to csv
        await writeCsv({
          path: failedCSVFile,
          data: failedRecords[sourceName],
        })
      }, { concurrency: 1 })
    }
    return doiStatus
  } catch (error){
    console.log(`Error on get path ${path}: ${error}`)
    return doiStatus // Returning what has been completed
  }
}

// async function synchronizeReviews(doi, personId, newPersonPubId) {
//   // check if the publication is already in the DB
//   const personPubsInDB = await getPersonPublications(doi, personId)
//   const reviews = {}
//   // assume reviews are ordered by datetime desc
//   _.each(personPubsInDB, (personPub) => {
//     // console.log(`Person Pub returned for review check is: ${JSON.stringify(personPub, null, 2)}`)
//     _.each(personPub.reviews_aggregate.nodes, (review) => {
//       if (!reviews[review.review_organization_value]) {
//         reviews[review.review_organization_value] = review
//       }
//     })
//   })

//   console.log(`New Person Pub Id is: ${JSON.stringify(newPersonPubId, null, 2)} inserting reviews: ${_.keys(reviews).length}`)
//   await pMap(_.keys(reviews), async (reviewOrgValue) => {
//     // insert with same org value and most recent status to get in sync with other pubs in DB
//     const review = reviews[reviewOrgValue]
//     // console.log(`Inserting review for New Person Pub Id: ${JSON.stringify(newPersonPubId, null, 2)}`)
//     const mutateResult = await client.mutate(
//       insertReview(review.user_id, newPersonPubId, review.review_type, reviewOrgValue)
//     )
//   }, { concurrency: 1})
// }

const getIngestFilePathsByYear = require('./getIngestFilePathsByYear');

//returns status map of what was done
async function main() {

const pathsByYear = await getIngestFilePathsByYear()

  //just get all simplified persons as will filter later
  const simplifiedPersons = await getAllSimplifiedPersons(client)

  let doiStatus = new Map()
  await pMap(_.keys(pathsByYear), async (year) => {
    //const simplifiedPersons = await getSimplifiedPersonsByYear(year)
    console.log(`Simplified persons for ${year} are: ${JSON.stringify(simplifiedPersons,null,2)}`)

    //create map of last name to array of related persons with same last name
    const personMap = _.transform(simplifiedPersons, function (result, value) {
      (result[value.lastName] || (result[value.lastName] = [])).push(value)
    }, {})

    console.log(`Loading ${year} Publication Data`)
    //load data
    await pMap(pathsByYear[year], async (path) => {
      const doiStatusByYear = await loadPersonPapersFromCSV(personMap, path, year)
      doiStatus[year] = doiStatusByYear
    }, { concurrency: 1})
  }, { concurrency: 1 })

  // console.log(`DOI Status: ${JSON.stringify(doiStatus,null,2)}`)
  _.each(_.keys(pathsByYear), (year) => {
    console.log(`DOIs errors for year ${year}: ${JSON.stringify(doiStatus[year].errorMessages, null, 2)}`)
    console.log(`DOIs failed: ${doiStatus[year].failedDOIs.length} for year: ${year}`)
    console.log(`DOIs added: ${doiStatus[year].addedDOIs.length} for year: ${year}`)
    console.log(`DOIs skipped: ${doiStatus[year].skippedDOIs.length} for year: ${year}`)
  })
}

main()
