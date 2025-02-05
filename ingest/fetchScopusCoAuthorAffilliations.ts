import _ from 'lodash'
import pMap from 'p-map'
import pTimes from 'p-times'
import { command as writeCsv } from './units/writeCsv'
import moment from 'moment'
import dotenv from 'dotenv'
import resolve from 'path'
import { randomWait } from './units/randomWait'

dotenv.config({
  path: '../.env'
})

const fs = require('fs');
const axios = require('axios');
const elsApiKey = process.env.SCOPUS_API_KEY
const elsCookie = process.env.SCOPUS_API_COOKIE

// environment variables
process.env.NODE_ENV = 'development';

// uncomment below line to test this code against staging environment
// process.env.NODE_ENV = 'staging';

// config variables
const config = require('../config/config.js');

async function getScopusAuthorData(authorGivenName, authorFamilyName, authorScopusId, year, pageSize, offset){
    const baseUrl = 'https://api.elsevier.com/content/search/scopus'

    const authorQuery = "AU-ID("+ authorScopusId +")"

    console.log(`Querying scopus with year: ${year} authorId: ${authorScopusId}, offset: ${offset}, and query: ${authorQuery}`)
    const response = await axios.get(baseUrl, {
        headers: {
          'X-ELS-APIKey' : elsApiKey,
        },
        params: {
          query : authorQuery,
          date: year,
          count: pageSize,
          start: offset
        }
      });

      return response.data;

}

async function getScopusPaperData(doi){
  const baseUrl = 'https://api.elsevier.com/content/search/scopus'

  const affiliationId = "60021508"

  //const authorQuery = (query) {
  //  return {
  //    "AF-ID("+ affiliationId + ")"
  //  }
  //}
  const doiQuery = "DOI(" + doi + ")"

  const response = await axios.get(baseUrl, {
      headers: {
        'X-ELS-APIKey' : elsApiKey,
      },
      params: {
        query : doiQuery
      }
    });

    return response.data;

}

async function getScopusPaperAffiliation (scopusId) {
  const baseUrl = `https://api.elsevier.com/content/abstract/scopus_id/${scopusId}`

  //const fullUrl = baseUrl + doi


  const response = await axios.get(baseUrl, {
    headers: {
      'httpAccept' : 'text/xml',
      'X-ELS-APIKey' : elsApiKey,
    }
  });

  if (!_.isArray(response.data['abstracts-retrieval-response']['affiliation'])) {
    let affiliations = []
    affiliations.push(response.data['abstracts-retrieval-response']['affiliation'])
    return affiliations
  } else {
    return response.data['abstracts-retrieval-response']['affiliation'];
  }
}
async function getSimplifiedPersons() {

  // const simplifiedPersons = _.map(queryResult.data.persons, (person) => {
  //   return {
  //     id: person.id,
  //     lastName: _.lowerCase(person.family_name),
  //     firstInitial: _.lowerCase(person.given_name[0]),
  //     firstName: _.lowerCase(person.given_name),
  //     startYear: person.start_date,
  //     endYear: person.end_date
  //   }
  // })
  const simplifiedPersons = [
    {
      authorId: '35227399700',
      lastName: 'hildreth',
      firstName: 'michael'
    },
    {
      authorId: '7004885835',
      lastName: 'tank',
      firstName: 'jennifer'
    } //,
    // {
    //   authorId: '57194218013',
    //   lastName: 'johnson',
    //   firstName: 'richard'
    // }
  ]
  return simplifiedPersons
}

//does multiple requests against scopus search to get all papers for a given author name for a given year
//returns a map of papers with paper scopus id mapped to the paper metadata
async function getScopusAuthorPapers(person, year) {

  try {
    let searchPageResults = []
    //set request set size
    const pageSize = 25
    let offset = 0

    //get first page of results, do with first initial for now
    const authorSearchResult = await getScopusAuthorData(person.firstInitial, person.lastName, person.authorId, year, pageSize, offset)
    //console.log(`Author Search Result first page: ${JSON.stringify(authorSearchResult,null,2)}`)
    if (authorSearchResult && authorSearchResult['search-results']['opensearch:totalResults']){
      const totalResults = parseInt(authorSearchResult['search-results']['opensearch:totalResults'])
      console.log(`Author Search Result Total Results: ${totalResults}`)
      if (totalResults > 0 && authorSearchResult['search-results']['entry']){
        //console.log(`Author ${person.lastName}, ${person.firstName} adding ${authorSearchResult['search-results']['entry'].length} results`)
        searchPageResults.push(authorSearchResult['search-results']['entry'])
        if (totalResults > pageSize){
          let numberOfRequests = parseInt(`${totalResults / pageSize}`) //convert to an integer to drop any decimal
          //if no remainder subtract one since already did one call
          if ((totalResults % pageSize) <= 0) {
            numberOfRequests -= 1
          }
          //loop to get the result of the results
          console.log(`Making ${numberOfRequests} requests for ${person.authorId}:${person.lastName}, ${person.firstName}`)
          await pTimes (numberOfRequests, async function (index) {
            randomWait(index)
            if (offset + pageSize < totalResults){
              offset += pageSize
            } else {
              offset += totalResults - offset
            }
            const authorSearchResultNext = await getScopusAuthorData(person.firstInitial, person.lastName, person.authorId, year, pageSize, offset)

            if (authorSearchResultNext['search-results']['entry']) {
              //console.log(`Getting Author Search Result page ${index+2}: ${authorSearchResultNext['search-results']['entry'].length} objects`)
              searchPageResults.push(authorSearchResultNext['search-results']['entry'])
            }
          }, { concurrency: 3})
        } else {
          console.log(`Author Search Result Total Results: ${totalResults}`)
        }
      }
    }

    //flatten the search results page as currently results one per page, and then keyBy scopus id
    return _.flattenDepth(searchPageResults, 1)
  } catch (error) {
    console.log(`Error on get info for person: ${error}`)
  }
}

//
// Takes in an array of scopus records and returns a hash of scopus id to object:
// 'year', 'title', 'journal', 'doi', 'scopus_id', 'scopus_record'
//
// scopus_record is the original json object
async function getSimplifliedScopusPapers(scopusPapers, simplifiedPerson){
  return _.map(scopusPapers, (paper) => {
    return {
      search_family_name : simplifiedPerson.lastName,
      search_given_name : simplifiedPerson.firstName,
      title: paper['dc:title'],
      journal: paper['prism:publicationName'],
      doi: paper['prism:doi'] ? paper['prism:doi'] : '',
      scopus_id: _.replace(paper['dc:identifier'], 'SCOPUS_ID:', ''),
      scopus_record : paper
    }
  })
}

// scopus_record is the original json object
function getSimplifiedPaperAffiliations(scopusPaper, scopusPaperAffiliations, simplifiedPerson){
  return _.map(scopusPaperAffiliations, (affiliation) => {
    affiliation['search_author_scopus_id'] = simplifiedPerson.authorId
    affiliation['search_author_lastname'] = simplifiedPerson.lastName
    affiliation['search_author_firstname'] = simplifiedPerson.firstName
    affiliation['scopus_paper_id'] = scopusPaper.scopus_id
    affiliation['title'] = scopusPaper.title
    return affiliation
  })
}

async function main (): Promise<void> {

  const years = [ 2020, 2019, 2018 ]
  const scopusAffiliationId = "60021508"
  const dataHarvestPath = `../data/harvest_${moment().format('YYYYMMDDHHmmss')}`

  fs.mkdirSync(dataHarvestPath, (err) => {
    if (err) throw err;
  });


  // group affiliations by country and push for publication and then author
  // author -> publication -> convert to counts by country per year
  // collapse affiliation items together into overall total array
  // author -> counts by country per year (total co-authors and country)
  // author -> counts total over all years (total co-authors and country)
  // author -> counts by country per paper by year (i.e., duplicates for country removed per paper)
  // in root -> year_author_total_pubs_by_country.csv (duplicates on co-authors removed) - one file for each year,
  //            year_author_total_coauthors_by_country.csv - one file for each year,
  //            all_author_total_pubs_by_country.csv (all years, duplicates on co-authors removed)
  //            all_author_total_coauthors_by_country.csv (all years),
  // folders -> raw_data -> all, 2020, 2019, 2018 -> lastName_scopusID -> pub -> affiliation items
  let authorCoauthorAffiliationByCountryByYear = {} //

  const simplifiedPersons = await getSimplifiedPersons()
  console.log(`Simplified persons are: ${JSON.stringify(simplifiedPersons,null,2)}`)

  await pMap(years, async (year) => {
    // //create map of last name to array of related persons with same last name
    // const personMap = _.transform(simplifiedPersons, function (result, value) {
    //   (result[value.lastName] || (result[value.lastName] = [])).push(value)
    // }, {})

    console.log(`Loading Person Publication Data`)
    //load data from scopus
    let personCounter = 0

    // and total country affiliations across all papers counting the country for each co-author
    let coauthorCountsByCountryAllPapers = {}

    // now get distinct counts for each country for papers independent of number of coauthors across all papers
    let distinctCountryCountsAllPapers = {}

    // get list of distinct countries across all authors
    let distinctCountries = {}

    const yearDataPath = `${dataHarvestPath}/${year}`
    //make the necessary directories
    fs.mkdirSync(yearDataPath, { recursive: true }, (err) => {
      if (err) throw err;
    });

    await pMap(simplifiedPersons, async (person) => {
      //const person = simplifiedPersons[0]

      let succeededScopusPapers = []
      let failedScopusPapers = []

      try {
        personCounter += 1
        randomWait(personCounter)

        // initialize the country count maps for this author
        coauthorCountsByCountryAllPapers[person.authorId] = {}
        distinctCountryCountsAllPapers[person.authorId] = {}

        const authorPapers = await getScopusAuthorPapers(person, year)
        //console.log(`Author Papers Found for ${person.lastName}, ${person.firstName}: ${JSON.stringify(authorPapers,null,2)}`)
        console.log(`Paper total for year: ${year} and author: ${person.lastName}, ${person.firstName}: ${JSON.stringify(_.keys(authorPapers).length,null,2)}`)

        //get simplified scopus papers
        const simplifiedAuthorPapers = await getSimplifliedScopusPapers(authorPapers, person)
        //console.log(`Simplified Scopus Author ${person.lastName}, ${person.firstName} Papers: ${JSON.stringify(simplifiedAuthorPapers,null,2)}`)

        //push in whole array for now and flatten later
        succeededScopusPapers.push(simplifiedAuthorPapers)

        //flatten out succeedScopusPaperArray for data for csv and change scopus json object to string
        const outputScopusPapers = _.map(_.flatten(succeededScopusPapers), paper => {
        paper['scopus_record'] = JSON.stringify(paper['scopus_record'])
          return paper
        })

        const personYearDataPath = `${yearDataPath}/${person.authorId}_${person.lastName}`
        //make the necessary directories
        fs.mkdirSync(personYearDataPath, { recursive: true }, (err) => {
          if (err) throw err;
        });

        //console.log(outputScopusPapers)
        await writeCsv({
          path: `${personYearDataPath}/scopus.${year}.${person.authorId}.${person.lastName}.csv`,
          data: outputScopusPapers,
        });
        console.log(`Total Succeeded Papers Author ${person.authorId}.${person.lastName}.${person.firstName}: ${outputScopusPapers.length}`)
        console.log(`Get error messages: ${JSON.stringify(failedScopusPapers,null,2)}`)

        // combine arrays and do total for countries by paper for each author
        let coauthorCountsByCountryByPaper = {}

        // get the affiliation arrays for each paper
        await pMap(outputScopusPapers, async (paper) => {
          //const paper = outputScopusPapers[0]
          // const paper = {
          //   scopus_id: '85082850250',
          //   title: 'Study of J/ψ meson production inside jets in pp collisions at s=8TeV'
          // }
          const paperAffiliations = await getScopusPaperAffiliation(paper.scopus_id)


          //console.log(`Author total paper affiliations for ${paper.scopus_id}:${paper.title}: ${JSON.stringify(paperAffiliations.length,null,2)}`)

          //console.log(`Paper affiliations for ${paper.scopus_id}:${paper.title}: ${JSON.stringify(paperAffiliations,null,2)}`)

          // get simplified paper affiliations
          const simplifiedPaperAffiliations = getSimplifiedPaperAffiliations(paper, paperAffiliations, person)

          // push affiliations into map by paper scopus id
          const affiliationsByCountry = _.groupBy(simplifiedPaperAffiliations, (affiliation) => {
            if (!affiliation['affiliation-country']) {
              console.log(`Incomplete affiliation for author: ${person.authorId} paper: ${paper.scopus_id} affiliation: ${JSON.stringify(affiliation, null, 2)}`)
            }
            return affiliation['affiliation-country'] ? affiliation['affiliation-country'].toLowerCase() : 'no_country'
          })

          coauthorCountsByCountryByPaper[paper.scopus_id] = {}

          const countries = _.keys(affiliationsByCountry)
          // now populate co-author counts categorized by country now that we have grouped by the country
          _.each(countries, function (country) {
            // count this paper and country pairing
            (distinctCountryCountsAllPapers[person.authorId][country]) ? distinctCountryCountsAllPapers[person.authorId][country] += 1 : distinctCountryCountsAllPapers[person.authorId][country] = 1
            // get total number of co-authors for this country and paper
            distinctCountries[country] = 0
            const countryCounts = affiliationsByCountry[country].length
            coauthorCountsByCountryByPaper[paper.scopus_id][country] = countryCounts
            // add to total co-author counts per country across all papers
            if (coauthorCountsByCountryAllPapers[person.authorId][country]) {
              coauthorCountsByCountryAllPapers[person.authorId][country] += countryCounts
            } else {
              // if no previous use current one as start of total
              coauthorCountsByCountryAllPapers[person.authorId][country] = countryCounts
            }
          })

          //console.log(`Simplified Paper Affiliations: ${JSON.stringify(simplifiedPaperAffiliations, null, 2)}`)

          // make a folder for author and write out affiliation data for each paper
          const paperDataPath = `${personYearDataPath}/${paper.scopus_id}`
          fs.mkdirSync(paperDataPath, { recursive: true }, (err) => {
            if (err) throw err;
          });

          //write data out to csv
          await writeCsv({
            path: `${paperDataPath}/scopus.${year}.au_id_${person.authorId}.${person.lastName}.${paper.scopus_id}.csv`,
            data: simplifiedPaperAffiliations,
          });
        }, {concurrency: 3})
      } catch (error) {
        const errorMessage = `Error on get scopus papers for author: ${person.authorId}.${person.lastName}.${person.firstName}: ${error}`
        failedScopusPapers.push(errorMessage)
        console.log(errorMessage)
      }
    }, {concurrency: 3})

    // finally create array of counts, one row per author with union of all countries found
    // where if not found for a particular author make count 0
    // get list of countries
    let countries = _.keys(distinctCountries)
    let coauthorCountsByCountryRows = []
    // now populate row of values for each author for number of papers by country
    // and number for each country counted for each coauthor across all papers
    _.each(simplifiedPersons, (person) => {
      let coauthorCountsByCountryRow = {
        // add author information
        author_id: person.authorId,
        author_lastname: person.lastName,
        author_firstname: person.firstName
      }
      // populate the values in each column for this row
      _.each(countries, (country) => {
        if (coauthorCountsByCountryAllPapers[person.authorId][country]) {
          coauthorCountsByCountryRow[country] = coauthorCountsByCountryAllPapers[person.authorId][country]
        } else {
          coauthorCountsByCountryRow[country] = 0
        }
      })
      coauthorCountsByCountryRows.push(coauthorCountsByCountryRow)
    })

    // next populate row for distinct country and author for papers
    // just need to add the author id and push into the array
    let distinctCountryCountsRows  = []
    _.each(simplifiedPersons, (person) => {
      let distinctCountryCountsRow = {
        // add author information
        author_id: person.authorId,
        author_lastname: person.lastName,
        author_firstname: person.firstName
      }
      // populate the values in each column for this row
      _.each(countries, (country) => {
        if (distinctCountryCountsAllPapers[person.authorId][country]) {
          distinctCountryCountsRow[country] = distinctCountryCountsAllPapers[person.authorId][country]
        } else {
          distinctCountryCountsRow[country] = 0
        }
      })
      distinctCountryCountsRows.push(distinctCountryCountsRow)
    })

    console.log(`coauthor counts by country rows ${JSON.stringify(coauthorCountsByCountryRows, null, 2)}`)
    console.log(`distinct country counts ${JSON.stringify(distinctCountryCountsRows, null, 2)}`)

    // now write the files
    await writeCsv({
      path: `${yearDataPath}/scopus.${year}.coauthor_counts_by_country.csv`,
      data: coauthorCountsByCountryRows,
    });

    await writeCsv({
      path: `${yearDataPath}/scopus.${year}.distinct_paper_counts_by_country.csv`,
      data: distinctCountryCountsRows,
    });
  }, { concurrency: 1 })
}

main();
